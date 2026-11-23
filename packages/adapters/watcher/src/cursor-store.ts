import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface FileCursor {
  offset: number;
  ino: number;
  parserState?: unknown;
}

function validCursor(value: unknown): FileCursor | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.offset !== 'number' || !Number.isInteger(v.offset) || v.offset < 0) return null;
  if (typeof v.ino !== 'number' || !Number.isFinite(v.ino)) return null;
  return { offset: v.offset, ino: v.ino, parserState: v.parserState };
}

export class CursorStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  keyFor(path: string): string {
    const base = (path.split('/').pop() ?? 'transcript').replace(/[^A-Za-z0-9._-]/g, '-');
    return `${base}-${createHash('sha1').update(path).digest('hex').slice(0, 12)}.json`;
  }

  async load(path: string): Promise<FileCursor | null> {
    try {
      const raw = await readFile(join(this.dir, this.keyFor(path)), 'utf8');
      return validCursor(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async save(path: string, cursor: FileCursor): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const target = join(this.dir, this.keyFor(path));
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cursor) + '\n', { mode: 0o600 });
    await rename(tmp, target);
    await chmod(target, 0o600);
  }
}