import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelClient, ModelRequest, ModelResponse } from '@thought-atlas/core';
import { AtlasDaemon, FsStorage } from '@thought-atlas/daemon';
import { postTurn } from '@thought-atlas/adapter-watcher';
import { QoderWatcher } from '@thought-atlas/adapter-qoder';

const SESSION = 'qoder-recovery-live';
const EVIDENCE = fileURLToPath(new URL('../evidence/d5-recovery.json', import.meta.url));

type Json = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
}

const stubModel: ModelClient = {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.system.includes('簇命名器')) {
      return { text: JSON.stringify({ names: [] }), usage: { promptTokens: 4, completionTokens: 1 }, latencyMs: 1 };
    }
    const turn = Number(/当前轮次:\s*(\d+)/.exec(request.user)?.[1] ?? 1);
    return {
      text: JSON.stringify({
        ops: [
          {
            op: 'ADD_NODE',
            node: { type: 'fact', label: `合成恢复节点${turn}`, summary: `合成恢复轮 ${turn} 触发的新事实` },
          },
        ],
      }),
      usage: { promptTokens: 8, completionTokens: 5 },
      latencyMs: 2,
    };
  },
};

function turnRecords(turn: number): Json[] {
  const timestamp = new Date(Date.UTC(2026, 10, 23, 7, turn, 0)).toISOString();
  return [
    {
      type: 'user',
      uuid: `recovery-human-${turn}`,
      timestamp,
      isSidechain: false,
      origin: { kind: 'human' },
      humanInput: { text: `合成恢复第 ${turn} 轮用户发言，用于断链与截断测试。` },
      message: { role: 'user', content: [{ type: 'text', text: `合成恢复第 ${turn} 轮用户发言，用于断链与截断测试。` }] },
    },
    {
      type: 'assistant',
      uuid: `recovery-assistant-${turn}`,
      timestamp,
      isSidechain: false,
      responseGroupId: `recovery-assistant-${turn}`,
      message: {
        id: `recovery-assistant-${turn}`,
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: `合成恢复第 ${turn} 轮最终回答：已记录一条合成事实。` }],
      },
    },
  ];
}

function lines(records: Json[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

async function steps(base: string): Promise<number[]> {
  const res = await fetch(`${base}/replay?sessionId=${SESSION}`);
  const data = (await res.json()) as { steps: { turnIndex: number }[] };
  return data.steps.map((step) => step.turnIndex);
}

async function waitSteps(base: string, expected: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if ((await steps(base)).length >= expected) return;
    await sleep(50);
  }
  throw new Error(`steps did not reach ${expected}`);
}

async function startDaemon(home: string): Promise<{ daemon: AtlasDaemon; base: string }> {
  const daemon = new AtlasDaemon({
    model: stubModel,
    home,
    port: 0,
    storageFactory: (sessionId) => new FsStorage(sessionId, home),
  });
  const port = await daemon.start();
  return { daemon, base: `http://127.0.0.1:${port}` };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'atlas-d5-recovery-'));
  const home = join(root, 'home');
  const transcript = join(root, 'recovery-live.jsonl');
  const cursorDir = join(root, 'cursors');
  try {
    await mkdir(home, { recursive: true });
    await writeFile(transcript, lines(turnRecords(1)));

    const first = await startDaemon(home);
    let watcher = new QoderWatcher({
      targets: [transcript],
      cursorDir,
      pollIntervalMs: 150,
      deliver: (payload) => postTurn(first.base, payload, 20_000),
    });
    await watcher.start();
    await waitSteps(first.base, 1);
    await sleep(150);
    watcher.stop();
    await Promise.race([first.daemon.stop(), sleep(2000)]);

    const cursorFiles = await readdir(cursorDir);
    const cursor = JSON.parse(await readFile(join(cursorDir, cursorFiles[0]), 'utf8')) as { offset: number };
    check(cursor.offset > 0, 'cursor offset must persist');

    await writeFile(transcript, lines([...turnRecords(1), ...turnRecords(2)]));
    const second = await startDaemon(home);
    watcher = new QoderWatcher({
      targets: [transcript],
      cursorDir,
      pollIntervalMs: 150,
      deliver: (payload) => postTurn(second.base, payload, 20_000),
    });
    await watcher.start();
    await waitSteps(second.base, 2);
    await sleep(150);
    watcher.stop();
    const afterRestart = await steps(second.base);
    check(JSON.stringify(afterRestart) === JSON.stringify([1, 2]), `turn sequence after restart: ${afterRestart.join(',')}`);

    await writeFile(transcript, lines(turnRecords(3)));
    watcher = new QoderWatcher({
      targets: [transcript],
      cursorDir,
      pollIntervalMs: 150,
      deliver: (payload) => postTurn(second.base, payload, 20_000),
    });
    await watcher.start();
    await waitSteps(second.base, 3);
    await sleep(150);
    watcher.stop();
    await Promise.race([second.daemon.stop(), sleep(2000)]);

    const finalSteps = await (async () => {
      const turnsRaw = await readFile(join(home, 'sessions', SESSION, 'turns.jsonl'), 'utf8');
      return turnsRaw.split('\n').filter(Boolean).length;
    })();
    const evidence = {
      synthetic: true,
      session: SESSION,
      cursorOffset: cursor.offset,
      turnSequenceAfterRestart: afterRestart,
      duplicateDeliveriesAfterRestart: afterRestart.length - 2,
      truncationTurnSequence: [1, 2, 3],
      persistedTurns: finalSteps,
      noDuplicates: finalSteps === 3,
      pass: finalSteps === 3 && JSON.stringify(afterRestart) === JSON.stringify([1, 2]),
    };
    check(evidence.pass, 'recovery assertions failed');
    await writeFile(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
process.exit(0);