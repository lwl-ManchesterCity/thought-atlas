import type {
  EventRecord,
  FailureRecord,
  GraphMap,
  SessionMeta,
  TurnPayload,
} from './core/types.ts';
import type { Storage } from './core/ports.ts';
import type { DbClient } from './db.ts';
import { insertRow, rows, updateRows } from './db.ts';

export class DbStorage implements Storage {
  private db: DbClient;
  private sessionId: string;

  constructor(db: DbClient, sessionId: string) {
    this.db = db;
    this.sessionId = sessionId;
  }

  // 沙箱原文不留存：turn 文本不落库，只保留输入哈希（见 sandbox_turns）
  async appendTurn(_payload: TurnPayload): Promise<void> {}

  async appendEvent(record: EventRecord): Promise<void> {
    await insertRow(this.db, 'graph_events', {
      id: crypto.randomUUID(),
      session_id: this.sessionId,
      turn_index: record.turnIndex,
      timestamp: record.timestamp,
      ops: record.ops,
    });
  }

  async appendFailure(record: FailureRecord): Promise<void> {
    await insertRow(this.db, 'graph_failures', {
      id: crypto.randomUUID(),
      session_id: this.sessionId,
      turn_index: record.turnIndex,
      reason: record.reason.slice(0, 500),
      created_at: new Date().toISOString(),
    });
  }

  async saveMap(map: GraphMap): Promise<void> {
    const now = new Date().toISOString();
    const existing = await rows<{ session_id: string }>(
      this.db.from('graph_maps').select('session_id').eq('session_id', this.sessionId).limit(1),
    );
    if (existing.length) {
      await updateRows(this.db, 'graph_maps', { map, updated_at: now }, { session_id: this.sessionId });
    } else {
      await insertRow(this.db, 'graph_maps', { session_id: this.sessionId, map, updated_at: now });
    }
  }

  async loadMap(): Promise<GraphMap | null> {
    const found = await rows<{ map: GraphMap }>(
      this.db.from('graph_maps').select('map').eq('session_id', this.sessionId).limit(1),
    );
    return found[0]?.map ?? null;
  }

  async loadEvents(): Promise<EventRecord[]> {
    const found = await rows<{ turn_index: number; timestamp: string; ops: EventRecord['ops'] }>(
      this.db
        .from('graph_events')
        .select('turn_index,timestamp,ops')
        .eq('session_id', this.sessionId)
        .order('turn_index', { ascending: true })
        .limit(5000),
    );
    return found.map((row) => ({ turnIndex: row.turn_index, timestamp: row.timestamp, ops: row.ops }));
  }

  async saveMeta(meta: SessionMeta): Promise<void> {
    const existing = await rows<{ session_id: string }>(
      this.db.from('graph_meta').select('session_id').eq('session_id', this.sessionId).limit(1),
    );
    if (existing.length) {
      await updateRows(
        this.db,
        'graph_meta',
        { title: meta.title.slice(0, 200), created_at: meta.createdAt },
        { session_id: this.sessionId },
      );
    } else {
      await insertRow(this.db, 'graph_meta', {
        session_id: this.sessionId,
        title: meta.title.slice(0, 200),
        created_at: meta.createdAt,
      });
    }
  }
}