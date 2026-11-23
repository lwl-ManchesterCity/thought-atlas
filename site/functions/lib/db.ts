import { AppError } from './errors.ts';

export interface DbError {
  code?: string;
  status?: number;
}

export interface DbResult<T> {
  data: T[] | null;
  error: DbError | null;
}

export interface DbQuery extends PromiseLike<DbResult<Record<string, unknown>>> {
  select(columns?: string): DbQuery;
  eq(column: string, value: unknown): DbQuery;
  order(column: string, options?: { ascending?: boolean }): DbQuery;
  limit(count: number): DbQuery;
}

export interface DbTable {
  select(columns?: string): DbQuery;
  insert(values: Record<string, unknown>): DbQuery;
  update(values: Record<string, unknown>): DbQuery;
}

export interface DbClient {
  from(table: string): DbTable;
}

export async function rows<T>(query: DbQuery): Promise<T[]> {
  let result: DbResult<Record<string, unknown>>;
  try {
    result = await query;
  } catch {
    throw new AppError('database_unavailable', 503);
  }
  if (result.error) throw new AppError('database_unavailable', 503);
  return (result.data ?? []) as T[];
}

export async function insertRow(db: DbClient, table: string, values: Record<string, unknown>): Promise<void> {
  await rows(db.from(table).insert(values));
}

export async function updateRows(
  db: DbClient,
  table: string,
  values: Record<string, unknown>,
  filters: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  let query = db.from(table).update(values);
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
  return rows(query.select());
}