import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TurnPayload } from '@thought-atlas/core';
import { CursorStore, JsonlWatcher } from '@thought-atlas/adapter-watcher';
import { loadQoderWatchTargets } from './qoder-config.ts';
import { qoderParserModule } from './qoder-module.ts';

export interface QoderWatcherOptions {
  configPath?: string;
  projectsDir?: string;
  cursorDir?: string;
  targets?: string[];
  pollIntervalMs?: number;
  mode?: 'tail' | 'from-start';
  deliver: (payload: TurnPayload) => Promise<void>;
  onTurn?: (payload: TurnPayload) => void;
}

export class QoderWatcher {
  private watcher: JsonlWatcher;

  constructor(options: QoderWatcherOptions) {
    const configPath = options.configPath ?? join(homedir(), '.thought-atlas', 'config.json');
    const projectsDir = options.projectsDir ?? join(homedir(), '.qoder-cn', 'projects');
    const cursorStore = new CursorStore(options.cursorDir ?? join(homedir(), '.thought-atlas', 'watcher-cursors'));
    this.watcher = new JsonlWatcher({
      listPaths: () =>
        options.targets ?? loadQoderWatchTargets({ configPath, projectsDir }),
      parserFor: () => qoderParserModule,
      mode: options.mode ?? 'from-start',
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      deliver: options.deliver,
      onTurn: options.onTurn,
      cursorStore,
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
}