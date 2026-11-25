import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

export function threadIdFromSessionId(sessionId: string): string | null {
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_|$)/.exec(sessionId);
  return m ? m[1] : null;
}

const cache = new Map<string, { mtimeMs: number; titles: Map<string, string> }>();

export async function readSessionTitles(home: string = codexHome()): Promise<Map<string, string>> {
  const path = join(home, 'session_index.jsonl');
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    cache.delete(path);
    return new Map();
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.titles;
  const titles = new Map<string, string>();
  const raw = await readFile(path, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: { id?: unknown; thread_name?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // append-only index: the last row per id carries the current (renamed) title
    if (typeof entry.id === 'string' && typeof entry.thread_name === 'string' && entry.thread_name.trim()) {
      titles.set(entry.id, entry.thread_name);
    }
  }
  cache.set(path, { mtimeMs, titles });
  return titles;
}