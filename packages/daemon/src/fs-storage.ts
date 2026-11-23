import { mkdir, appendFile, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  EventRecord,
  FailureRecord,
  GraphMap,
  SessionMeta,
  Storage,
  TurnPayload,
} from '@thought-atlas/core';

export function atlasHome(): string {
  return process.env.THOUGHT_ATLAS_HOME ?? join(homedir(), '.thought-atlas');
}

export class FsStorage implements Storage {
  private dir: string;

  constructor(sessionId: string, home: string = atlasHome()) {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      throw new Error('invalid sessionId');
    }
    this.dir = join(home, 'sessions', sessionId);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async appendTurn(payload: TurnPayload): Promise<void> {
    await this.ensureDir();
    await appendFile(join(this.dir, 'turns.jsonl'), JSON.stringify(payload) + '\n');
  }

  async appendEvent(record: EventRecord): Promise<void> {
    await this.ensureDir();
    await appendFile(join(this.dir, 'events.jsonl'), JSON.stringify(record) + '\n');
  }

  async appendFailure(record: FailureRecord): Promise<void> {
    await this.ensureDir();
    await appendFile(join(this.dir, 'failures.jsonl'), JSON.stringify(record) + '\n');
  }

  async saveMap(map: GraphMap): Promise<void> {
    await this.ensureDir();
    const target = join(this.dir, 'map.json');
    const tmp = target + '.tmp';
    await writeFile(tmp, JSON.stringify(map, null, 2));
    await rename(tmp, target);
  }

  async loadMap(): Promise<GraphMap | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, 'map.json'), 'utf8')) as GraphMap;
    } catch {
      return null;
    }
  }

  async loadEvents(): Promise<EventRecord[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, 'events.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const records: EventRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as EventRecord);
      } catch {
        break;
      }
    }
    return records;
  }

  async saveMeta(meta: SessionMeta): Promise<void> {
    await this.ensureDir();
    await writeFile(join(this.dir, 'meta.json'), JSON.stringify(meta, null, 2));
  }
}