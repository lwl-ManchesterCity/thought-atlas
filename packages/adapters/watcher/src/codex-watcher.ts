import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TurnPayload } from '@thought-atlas/core';
import { RolloutParser, RolloutCursorReader, sessionIdFromRolloutPath } from '@thought-atlas/adapter-codex';

export interface WatcherOptions {
  sessionsDir?: string;
  pollIntervalMs?: number;
  mode?: 'tail' | 'from-start';
  deliver: (payload: TurnPayload) => Promise<void>;
  onTurn?: (payload: TurnPayload) => void;
}

interface FileEntry {
  reader: RolloutCursorReader;
  parser: RolloutParser;
}

export class CodexWatcher {
  private sessionsDir: string;
  private pollIntervalMs: number;
  private mode: 'tail' | 'from-start';
  private deliver: (payload: TurnPayload) => Promise<void>;
  private onTurn?: (payload: TurnPayload) => void;
  private files = new Map<string, FileEntry>();
  private pending: TurnPayload[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: WatcherOptions) {
    this.sessionsDir = options.sessionsDir ?? join(homedir(), '.codex', 'sessions');
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.mode = options.mode ?? 'tail';
    this.deliver = options.deliver;
    this.onTurn = options.onTurn;
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
      for (const path of await this.findRollouts(this.sessionsDir)) {
        let entry = this.files.get(path);
        if (!entry) {
          const reader = new RolloutCursorReader(path, 0);
          // 续写 rollout 共享 thread session_id，按文件映射独立会话避免轮次冲突
          const parser = new RolloutParser({ sessionId: sessionIdFromRolloutPath(path) });
          if (this.mode === 'tail') {
            // 静默消费历史：建立 sessionId/轮次计数/turn_id 去重，保证后续 turnIndex 连续且不重复投递
            for (const line of await reader.readNewLines()) parser.feedLine(line);
          }
          entry = { reader, parser };
          this.files.set(path, entry);
        }
        for (const line of await entry.reader.readNewLines()) {
          const turn = entry.parser.feedLine(line);
          if (turn) this.pending.push(turn);
        }
      }
      await this.flush();
    } catch {
      // 只读适配器：任何异常静默，绝不影响 agent
    } finally {
      this.ticking = false;
    }
  }

  private async flush(): Promise<void> {
    const queue = this.pending;
    this.pending = [];
    for (const payload of queue) {
      try {
        await this.deliver(payload);
        this.onTurn?.(payload);
      } catch {
        this.pending.push(payload);
      }
    }
  }

  private async findRollouts(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.findRollouts(path)));
      } else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
        out.push(path);
      }
    }
    return out;
  }
}

export async function postTurn(daemonUrl: string, payload: TurnPayload): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(daemonUrl.replace(/\/$/, '') + '/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`daemon HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}