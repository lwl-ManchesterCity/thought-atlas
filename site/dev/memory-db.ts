import type { DbClient, DbError, DbQuery, DbResult, DbTable } from '../functions/lib/db.ts';

type Row = Record<string, unknown>;

const PRIMARY_KEYS: Record<string, string[]> = {
  sandbox_sessions: ['id'],
  sandbox_turns: ['id'],
  analysis_cache: ['cache_key'],
  daily_counters: ['day'],
  graph_events: ['id'],
  graph_maps: ['session_id'],
  graph_failures: ['id'],
  graph_meta: ['session_id'],
};

const UNIQUE_KEYS: Record<string, string[][]> = {
  sandbox_turns: [['session_id', 'turn_index']],
  graph_events: [['session_id', 'turn_index']],
};

function matches(row: Row, filters: [string, unknown][]): boolean {
  return filters.every(([key, value]) => row[key] === value);
}

function pick(row: Row, columns?: string): Row {
  if (!columns) return { ...row };
  const out: Row = {};
  for (const key of columns.split(',').map((part) => part.trim()).filter(Boolean)) {
    out[key] = row[key];
  }
  return out;
}

function missingKey(table: string, row: Row): boolean {
  return (PRIMARY_KEYS[table] ?? []).some((key) => row[key] === undefined);
}

function primaryConflict(store: Row[], table: string, row: Row): boolean {
  const keys = PRIMARY_KEYS[table] ?? [];
  if (!keys.length) return false;
  return store.some((existing) => keys.every((key) => existing[key] === row[key]));
}

export class MemoryDb implements DbClient {
  tables: Record<string, Row[]> = {};
  failNext = false;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.tables = {
      sandbox_sessions: [],
      sandbox_turns: [],
      analysis_cache: [],
      daily_counters: [],
      graph_events: [],
      graph_maps: [],
      graph_failures: [],
      graph_meta: [],
    };
    this.failNext = false;
  }

  dump(table: string): Row[] {
    return (this.tables[table] ?? []).map((row) => ({ ...row }));
  }

  from(table: string): DbTable {
    const store = this.tables[table];
    if (!store) throw new Error(`unknown table ${table}`);

    const state = {
      mode: 'read' as 'read' | 'insert' | 'update',
      columns: undefined as string | undefined,
      filters: [] as [string, unknown][],
      order: [] as [string, boolean][],
      limit: undefined as number | undefined,
      values: undefined as Row | undefined,
    };

    const run = (): DbResult<Row> => {
      if (this.failNext) {
        this.failNext = false;
        return { data: null, error: { code: 'database_unavailable', status: 503 } as DbError };
      }
      if (state.mode === 'insert') {
        const values = state.values ?? {};
        const row: Row = { ...values };
        const pk = PRIMARY_KEYS[table] ?? [];
        for (const key of pk) if (row[key] === undefined) row[key] = crypto.randomUUID();
        if (missingKey(table, row) || primaryConflict(store, table, row)) {
          return { data: null, error: { code: 'duplicate_key', status: 409 } };
        }
        const conflict = (UNIQUE_KEYS[table] ?? []).some((keys) =>
          store.some((existing) => keys.every((key) => existing[key] === row[key])),
        );
        if (conflict) return { data: null, error: { code: 'duplicate_key', status: 409 } };
        store.push(row);
        return { data: [pick(row, state.columns)], error: null };
      }

      let rows = store.filter((row) => matches(row, state.filters));
      if (state.mode === 'update') {
        for (const row of rows) Object.assign(row, state.values ?? {});
      }
      for (const [key, ascending] of [...state.order].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[key] as string | number;
          const bv = b[key] as string | number;
          return (av < bv ? -1 : av > bv ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (state.limit !== undefined) rows = rows.slice(0, state.limit);
      return { data: rows.map((row) => pick(row, state.columns)), error: null };
    };

    const query: DbQuery = {
      select(columns?: string) {
        state.columns = columns;
        return query;
      },
      eq(column: string, value: unknown) {
        state.filters.push([column, value]);
        return query;
      },
      order(column: string, options?: { ascending?: boolean }) {
        state.order.push([column, options?.ascending !== false]);
        return query;
      },
      limit(count: number) {
        state.limit = count;
        return query;
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(run()).then(onFulfilled, onRejected);
      },
    };

    return {
      select(columns?: string) {
        state.mode = 'read';
        state.columns = columns;
        return query;
      },
      insert(values: Row) {
        state.mode = 'insert';
        state.values = values;
        return query;
      },
      update(values: Row) {
        state.mode = 'update';
        state.values = values;
        return query;
      },
    };
  }
}