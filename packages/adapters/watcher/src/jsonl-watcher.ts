import { stat } from 'node:fs/promises';
import type { TurnPayload } from '@thought-atlas/core';
import { RolloutCursorReader } from '@thought-atlas/adapter-codex';
import { CursorStore } from './cursor-store.ts';
import type { ParserModule, TranscriptParser } from './parser.ts';

export interface JsonlWatcherOptions {
  listPaths: () => Promise<string[]> | string[];
  parserFor: (path: string) => ParserModule | null;
  mode?: 'tail' | 'from-start';
  deliver: (payload: TurnPayload) => Promise<void>;
  onTurn?: (payload: TurnPayload) => void;
  pollIntervalMs?: number;
  cursorStore?: CursorStore;
}

interface FileEntry {
  reader: RolloutCursorReader;
  parser: TranscriptParser;
  module: ParserModule;
  ino: number;
  dirty: boolean;
}

export class JsonlWatcher {
  private listPaths: JsonlWatcherOptions['listPaths'];
  private parserFor: JsonlWatcherOptions['parserFor'];
  private mode: 'tail' | 'from-start';
  private deliver: (payload: TurnPayload) => Promise<void>;
  private onTurn?: (payload: TurnPayload) => void;
  private pollIntervalMs: number;
  private cursorStore?: CursorStore;
  private files = new Map<string, FileEntry>();
  private pending: TurnPayload[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: JsonlWatcherOptions) {
    this.listPaths = options.listPaths;
    this.parserFor = options.parserFor;
    this.mode = options.mode ?? 'tail';
    this.deliver = options.deliver;
    this.onTurn = options.onTurn;
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.cursorStore = options.cursorStore;
  }

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let paths: string[] = [];
      try {
        paths = await this.listPaths();
      } catch {
        paths = [];
      }
      for (const path of paths) {
        try {
          await this.tickFile(path);
        } catch {
          // 只读适配器：单个文件异常静默，不影响其他目标与 agent
        }
      }
      const delivered = await this.flush();
      if (delivered) await this.persistCursors();
    } finally {
      this.ticking = false;
    }
  }

  private async tickFile(path: string): Promise<void> {
    const module = this.parserFor(path);
    if (!module) return;
    const st = await stat(path);
    if (!st.isFile()) return;

    let entry = this.files.get(path);
    if (!entry) {
      const saved = this.cursorStore ? await this.cursorStore.load(path) : null;
      const resume = saved !== null && saved.ino === st.ino && st.size >= saved.offset;
      const parser = module.create(path, resume ? { state: saved.parserState } : saved ? { state: saved.parserState, reparse: true } : undefined);
      const reader = new RolloutCursorReader(path, resume ? saved.offset : 0);
      entry = { reader, parser, module, ino: st.ino, dirty: false };
      this.files.set(path, entry);
      if (this.mode === 'tail' && !saved) {
        // 静默消费历史，建立轮次与去重状态；仅首次见到且无游标时生效
        for (const line of await reader.readNewLines()) parser.feedLine(line);
        entry.dirty = true;
        return;
      }
    }

    if (st.ino !== entry.ino || st.size < entry.reader.position) {
      // 截断/轮换：游标归零，保留解析器的稳定历史状态并重放新文件
      const state = entry.parser.snapshot?.();
      entry.reader = new RolloutCursorReader(path, 0);
      entry.parser = entry.module.create(path, { state, reparse: true });
      entry.ino = st.ino;
      entry.dirty = true;
    }

    const before = entry.reader.position;
    for (const line of await entry.reader.readNewLines()) {
      const turn = entry.parser.feedLine(line);
      if (turn) this.pending.push(turn);
    }
    if (entry.reader.position !== before) entry.dirty = true;
  }

  private async flush(): Promise<boolean> {
    const queue = this.pending;
    this.pending = [];
    let ok = true;
    for (const payload of queue) {
      try {
        await this.deliver(payload);
        this.onTurn?.(payload);
      } catch {
        ok = false;
        this.pending.push(payload);
      }
    }
    return ok && this.pending.length === 0;
  }

  private async persistCursors(): Promise<void> {
    if (!this.cursorStore) return;
    for (const [path, entry] of this.files) {
      if (!entry.dirty) continue;
      try {
        await this.cursorStore.save(path, {
          offset: entry.reader.position,
          ino: entry.ino,
          parserState: entry.parser.snapshot?.(),
        });
        entry.dirty = false;
      } catch {
        // 游标写失败不阻塞投递；下次 tick 重试
      }
    }
  }
}