import { mkdtemp, mkdir, copyFile, appendFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolloutParser, RolloutCursorReader, sessionIdFromRolloutPath } from '@thought-atlas/adapter-codex';
import { CodexWatcher, postTurn } from '@thought-atlas/adapter-watcher';
import { AtlasDaemon, DeepSeekClient, FsStorage, loadConfig } from '@thought-atlas/daemon';

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/d2-e2e-latency.ts <real-rollout.jsonl>');
  process.exit(1);
}

const work = await mkdtemp(join(tmpdir(), 'atlas-e2e-'));
const sessionsDir = join(work, 'sessions');
const home = join(work, 'atlas-home');
await mkdir(sessionsDir, { recursive: true });
await mkdir(home, { recursive: true });
const copy = join(sessionsDir, 'rollout-e2e-copy.jsonl');
await copyFile(source, copy);

const seedReader = new RolloutCursorReader(copy, 0);
const seedParser = new RolloutParser({ sessionId: sessionIdFromRolloutPath(copy) });
let historyTurns = 0;
let sessionId = '';
for (const line of await seedReader.readNewLines()) {
  const turn = seedParser.feedLine(line);
  if (turn) {
    historyTurns++;
    sessionId = turn.sessionId;
  }
}
if (!sessionId) throw new Error('copy has no parseable turns');

const config = await loadConfig();
const daemon = new AtlasDaemon({
  model: new DeepSeekClient(config),
  home,
  port: 0,
  retryIntervalMs: 0,
  storageFactory: (id) => new FsStorage(id, home),
});
const port = await daemon.start();
const base = `http://127.0.0.1:${port}`;

const watcher = new CodexWatcher({
  sessionsDir,
  pollIntervalMs: 1500,
  mode: 'tail',
  deliver: (payload) => postTurn(base, payload),
});
await watcher.start();

const ts = new Date().toISOString();
const syntheticTurn = [
  { timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: 'e2e-synthetic-1' } },
  {
    timestamp: ts, type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '我一直以为浮点数算不准是语言实现的 bug，今天才意识到这可能是表示方式本身的限制' }] },
  },
  {
    timestamp: ts, type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '对，IEEE754 用有限位数表示实数，误差是精度取舍的必然结果，不是实现缺陷。' }] },
  },
  {
    timestamp: ts, type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'e2e-synthetic-1', root_turn_id: 'e2e-synthetic-1', last_agent_message: '误差是精度取舍的必然结果。', completed_at: ts },
  },
];
await appendFile(copy, syntheticTurn.map((r) => JSON.stringify(r)).join('\n') + '\n');
const t0 = Date.now();

const expectedTurn = historyTurns + 1;
let visibleMs = -1;
let nodesVisible = 0;
for (;;) {
  const res = await fetch(`${base}/map?sessionId=${sessionId}`);
  const map = (await res.json()) as { lastTurn: number; nodes: unknown[] };
  if (map.lastTurn >= expectedTurn && map.nodes.length > 0) {
    visibleMs = Date.now() - t0;
    nodesVisible = map.nodes.length;
    break;
  }
  if (Date.now() - t0 > 15000) break;
  await new Promise((r) => setTimeout(r, 200));
}

const mapBefore = await (await fetch(`${base}/map?sessionId=${sessionId}`)).json();
const dupPayload = {
  sessionId,
  turnIndex: expectedTurn,
  userText: '我一直以为浮点数算不准是语言实现的 bug，今天才意识到这可能是表示方式本身的限制',
  assistantText: '对，IEEE754 用有限位数表示实数，误差是精度取舍的必然结果，不是实现缺陷。',
  timestamp: ts,
  source: 'codex',
};
const dupRes = await fetch(`${base}/turn`, { method: 'POST', body: JSON.stringify(dupPayload) });
const dupBody = (await dupRes.json()) as { status: string };
const mapAfter = await (await fetch(`${base}/map?sessionId=${sessionId}`)).json();
const duplicateIdempotent = dupBody.status === 'duplicate' && JSON.stringify(mapBefore) === JSON.stringify(mapAfter);

watcher.stop();
await daemon.stop();

const evidence = {
  date: new Date().toISOString(),
  method: '真实 rollout 复制到 /tmp，向副本追加合成轮；绝不修改真实文件',
  sessionId,
  historyTurns,
  appendToNodeVisibleMs: visibleMs,
  budgetMs: 8000,
  pass: visibleMs >= 0 && visibleMs <= 8000,
  nodesVisible,
  duplicateDeliveryIdempotent: duplicateIdempotent,
};
await writeFile(join('evidence', 'd2-e2e-latency.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
await rm(work, { recursive: true, force: true });
if (!evidence.pass || !duplicateIdempotent) process.exit(1);