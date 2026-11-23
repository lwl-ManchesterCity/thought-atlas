import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TurnPayload } from '@thought-atlas/core';
import { codexParserModule } from './codex-module.ts';
import { JsonlWatcher } from './jsonl-watcher.ts';

export interface WatcherOptions {
  sessionsDir?: string;
  pollIntervalMs?: number;
  mode?: 'tail' | 'from-start';
  deliver: (payload: TurnPayload) => Promise<void>;
  onTurn?: (payload: TurnPayload) => void;
}

export class CodexWatcher {
  private sessionsDir: string;
  private watcher: JsonlWatcher;

  constructor(options: WatcherOptions) {
    this.sessionsDir = options.sessionsDir ?? join(homedir(), '.codex', 'sessions');
    this.watcher = new JsonlWatcher({
      listPaths: () => this.findRollouts(this.sessionsDir),
      parserFor: () => codexParserModule,
      mode: options.mode ?? 'tail',
      pollIntervalMs: options.pollIntervalMs ?? 1500,
      deliver: options.deliver,
      onTurn: options.onTurn,
    });
  }

  async start(): Promise<void> {
    await this.watcher.start();
  }

  stop(): void {
    this.watcher.stop();
  }

  async tick(): Promise<void> {
    await this.watcher.tick();
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

export async function postTurn(daemonUrl: string, payload: TurnPayload, timeoutMs = 2000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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