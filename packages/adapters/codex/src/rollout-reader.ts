import { open, stat } from 'node:fs/promises';

export class RolloutCursorReader {
  private path: string;
  private cursor: number;

  constructor(path: string, initialCursor = 0) {
    this.path = path;
    this.cursor = initialCursor;
  }

  get position(): number {
    return this.cursor;
  }

  async readNewLines(): Promise<string[]> {
    const st = await stat(this.path);
    // 文件被截断/轮转时从头重读；turn_id 去重保证不重复投递
    if (st.size < this.cursor) this.cursor = 0;
    if (st.size === this.cursor) return [];

    const fh = await open(this.path, 'r');
    try {
      const len = st.size - this.cursor;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.cursor);
      const text = buf.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) return [];
      const complete = text.slice(0, lastNewline);
      this.cursor += Buffer.byteLength(complete, 'utf8') + 1;
      return complete.split('\n').filter((l) => l.trim().length > 0);
    } finally {
      await fh.close();
    }
  }
}