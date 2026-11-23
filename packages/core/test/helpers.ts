import type {
  EventRecord,
  FailureRecord,
  GraphMap,
  SessionMeta,
  Storage,
  TurnPayload,
} from '../src/index.ts';

export class MemoryStorage implements Storage {
  turns: TurnPayload[] = [];
  events: EventRecord[] = [];
  failures: FailureRecord[] = [];
  map: GraphMap | null = null;
  meta: SessionMeta | null = null;

  async appendTurn(payload: TurnPayload): Promise<void> {
    this.turns.push(payload);
  }
  async appendEvent(record: EventRecord): Promise<void> {
    this.events.push(record);
  }
  async appendFailure(record: FailureRecord): Promise<void> {
    this.failures.push(record);
  }
  async saveMap(map: GraphMap): Promise<void> {
    this.map = structuredClone(map);
  }
  async loadMap(): Promise<GraphMap | null> {
    return this.map ? structuredClone(this.map) : null;
  }
  async loadEvents(): Promise<EventRecord[]> {
    return structuredClone(this.events);
  }
  async saveMeta(meta: SessionMeta): Promise<void> {
    this.meta = meta;
  }
}

export const TS = '2026-11-23T10:00:00.000Z';