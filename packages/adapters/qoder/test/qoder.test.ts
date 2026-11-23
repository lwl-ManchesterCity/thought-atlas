import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnPayload } from '@thought-atlas/core';
import {
  QoderParser,
  QoderWatcher,
  loadQoderWatchTargets,
  normalizeTimestamp,
} from '../src/index.ts';
import { assistant, human, interruptedTurn, lines, sidechainNoise, toolResult, turn1, turn2, turn3 } from './fixtures.ts';

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function parseAll(records: Record<string, unknown>[]): TurnPayload[] {
  const parser = new QoderParser({ sessionId: 'qoder-synthetic-session-0001' });
  const out: TurnPayload[] = [];
  for (const record of records) {
    const turn = parser.feedLine(JSON.stringify(record));
    if (turn) out.push(turn);
  }
  return out;
}

test('streaming rows fold into one turn; tool_result/thinking/tool_use/attachment excluded', () => {
  const out = parseAll([...turn1(), ...sidechainNoise()]);
  assert.equal(out.length, 1);
  const turn = out[0];
  assert.equal(turn.sessionId, 'qoder-synthetic-session-0001');
  assert.equal(turn.source, 'qoder');
  assert.equal(turn.turnIndex, 1);
  assert.ok(turn.userText.includes('合成第一轮用户发言'));
  assert.equal(turn.assistantText, '合成第一轮最终回答：递归难在隐式调用栈，每一层都有自己的状态。');
  for (const noise of ['合成工具结果必须排除', '合成思考', '合成流式中间片段', '合成工具调用', '合成附件', '合成压缩摘要', '合成侧链']) {
    assert.ok(!turn.userText.includes(noise), noise);
    assert.ok(!turn.assistantText.includes(noise), noise);
  }
});

test('tool_result user rows do not open turns and do not enter user text', () => {
  const parser = new QoderParser({ sessionId: 'qoder-synthetic-session-0001' });
  assert.equal(parser.feedLine(JSON.stringify(toolResult('tool-only', '2026-11-23T04:00:00.000Z'))), null);
  const out: TurnPayload[] = [];
  for (const record of [...turn1(), ...turn2()]) {
    const turn = parser.feedLine(JSON.stringify(record));
    if (turn) out.push(turn);
  }
  assert.equal(out.length, 2);
  assert.ok(!out[0].userText.includes('合成工具结果'));
  assert.equal(out[1].turnIndex, 2);
});

test('interrupted turn without end_turn finalizes on the next human row', () => {
  const parser = new QoderParser({ sessionId: 'qoder-synthetic-session-0001' });
  const out: TurnPayload[] = [];
  for (const record of interruptedTurn()) {
    const turn = parser.feedLine(JSON.stringify(record));
    if (turn) out.push(turn);
  }
  assert.equal(out.length, 0);
  const nextHuman = human('human-next', '合成下一轮用户发言：继续刚才的话题。', '2026-11-23T04:11:00.000Z');
  const first = parser.feedLine(JSON.stringify(nextHuman));
  assert.ok(first);
  assert.equal(first.turnIndex, 1);
  assert.equal(first.userText, '合成被打断的用户发言：先别展开，我换个问题。');
  assert.equal(first.assistantText, '合成被打断前留下的非空正文');
  const final = parser.feedLine(
    JSON.stringify(assistant('msg-next', 'end_turn', [{ type: 'text', text: '合成下一轮回答正文。' }], '2026-11-23T04:11:10.000Z', 'asst-next')),
  );
  assert.ok(final);
  assert.equal(final.turnIndex, 2);
});

test('sidechain rows are skipped and wrapper tags are stripped from human text', () => {
  const parser = new QoderParser({ sessionId: 'qoder-synthetic-session-0001' });
  const out: TurnPayload[] = [];
  const wrapped = human(
    'human-wrapped',
    '<system-reminder>合成系统提醒必须排除</system-reminder><qoder_delegated_input_sources>合成委派来源必须排除</qoder_delegated_input_sources><user_instructions>合成注入指令必须排除</user_instructions>合成真实用户提问正文。',
    '2026-11-23T04:20:00.000Z',
  );
  const wrappedReply = assistant(
    'msg-wrapped',
    'end_turn',
    [{ type: 'text', text: '合成包装轮回答正文。' }],
    '2026-11-23T04:20:10.000Z',
    'asst-wrapped',
  );
  for (const record of [...sidechainNoise(), wrapped, wrappedReply]) {
    const turn = parser.feedLine(JSON.stringify(record));
    if (turn) out.push(turn);
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].turnIndex, 1);
  assert.equal(out[0].userText, '合成真实用户提问正文。');
  assert.ok(!out[0].userText.includes('合成系统提醒'));
});

test('timestamps normalize from epoch seconds or ISO while turn order follows file order', () => {
  const epoch = 1800000000;
  const out = parseAll([...turn1(), ...turn2()]);
  assert.equal(out.length, 2);
  assert.equal(out[0].timestamp, normalizeTimestamp(epoch));
  assert.equal(out[0].timestamp, new Date(epoch * 1000).toISOString());
  assert.equal(out[1].timestamp, '2026-11-23T04:05:00.000Z');
  assert.ok(out[0].timestamp > out[1].timestamp);
  assert.deepEqual(out.map((turn) => turn.turnIndex), [1, 2]);
});

test('parser snapshot resumes an in-progress turn across a restart', () => {
  const parser = new QoderParser({ sessionId: 'qoder-synthetic-session-0001' });
  const records = [...turn1(), ...turn2()];
  assert.equal(parser.feedLine(JSON.stringify(records[0])), null);
  assert.equal(parser.feedLine(JSON.stringify(records[1])), null);
  const firstAsst = parser.feedLine(JSON.stringify(records[2]));
  assert.equal(firstAsst, null);
  const state = parser.snapshot();

  const resumed = new QoderParser({ sessionId: 'qoder-synthetic-session-0001', state });
  const out: TurnPayload[] = [];
  for (const record of records.slice(3)) {
    const turn = resumed.feedLine(JSON.stringify(record));
    if (turn) out.push(turn);
  }
  assert.equal(out.length, 2);
  assert.equal(out[0].turnIndex, 1);
  assert.equal(out[0].assistantText, '合成第一轮最终回答：递归难在隐式调用栈，每一层都有自己的状态。');
  assert.equal(out[1].turnIndex, 2);
});

test('reparse keeps known human ids and emits only new turns with monotonic indexes', () => {
  const first = parseAll([...turn1(), ...turn2()]);
  assert.equal(first.length, 2);

  const parser = new QoderParser({ sessionId: 'qoder-synthetic-session-0001' });
  for (const record of [...turn1(), ...turn2()]) parser.feedLine(JSON.stringify(record));
  const replayed = new QoderParser({ sessionId: 'qoder-synthetic-session-0001', state: parser.snapshot(), reparse: true });
  const out: TurnPayload[] = [];
  for (const record of [...turn1(), ...turn2(), ...turn3()]) {
    const turn = replayed.feedLine(JSON.stringify(record));
    if (turn) out.push(turn);
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].turnIndex, 3);
  assert.ok(out[0].userText.includes('合成第三轮'));
});

test('watcher backfills, resumes from persisted cursor, and detects truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-qoder-'));
  const file = join(root, 'synthetic-qoder-0001.jsonl');
  const cursorDir = join(root, 'cursors');
  try {
    await writeFile(file, lines(turn1()));
    const delivered: TurnPayload[] = [];
    const watcher = new QoderWatcher({
      targets: [file],
      cursorDir,
      pollIntervalMs: 20,
      deliver: async (payload) => { delivered.push(payload); },
    });
    await watcher.start();
    await waitFor(() => delivered.length >= 1);
    assert.equal(delivered[0].turnIndex, 1);
    watcher.stop();
    await new Promise((r) => setTimeout(r, 80));

    const restarted = new QoderWatcher({
      targets: [file],
      cursorDir,
      pollIntervalMs: 20,
      deliver: async (payload) => { delivered.push(payload); },
    });
    await restarted.start();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(delivered.length, 1);
    await appendFile(file, lines(turn2()));
    await waitFor(() => delivered.length >= 2);
    assert.equal(delivered[1].turnIndex, 2);
    restarted.stop();
    await new Promise((r) => setTimeout(r, 80));

    const truncated = await stat(file);
    assert.ok(truncated.size > 0);
    await writeFile(file, lines(turn3()));
    const afterTruncate = await stat(file);
    assert.ok(afterTruncate.size < truncated.size);

    const resumed = new QoderWatcher({
      targets: [file],
      cursorDir,
      pollIntervalMs: 20,
      deliver: async (payload) => { delivered.push(payload); },
    });
    await resumed.start();
    await waitFor(() => delivered.length >= 3);
    resumed.stop();
    assert.equal(delivered[2].turnIndex, 3);
    assert.ok(delivered[2].userText.includes('合成第三轮'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('watcher waits for a complete JSONL line before delivering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-qoder-'));
  const file = join(root, 'synthetic-qoder-0001.jsonl');
  try {
    await writeFile(file, lines(turn1()));
    const delivered: TurnPayload[] = [];
    const watcher = new QoderWatcher({
      targets: [file],
      cursorDir: join(root, 'cursors'),
      pollIntervalMs: 20,
      deliver: async (payload) => { delivered.push(payload); },
    });
    await watcher.start();
    await waitFor(() => delivered.length >= 1);

    const second = turn2();
    await appendFile(file, JSON.stringify(second[0]));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(delivered.length, 1);
    await appendFile(file, '\n' + second.slice(1).map((record) => JSON.stringify(record)).join('\n') + '\n');
    await waitFor(() => delivered.length >= 2);
    watcher.stop();
    assert.equal(delivered[1].turnIndex, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('whitelist resolves exact session ids only and ignores unlisted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-qoder-config-'));
  const projects = join(root, 'projects');
  const wantedDir = join(projects, 'wanted-workspace');
  const otherDir = join(projects, 'private-workspace');
  const configPath = join(root, 'config.json');
  const wanted = join(wantedDir, 'wanted-session.jsonl');
  const other = join(otherDir, 'other-session.jsonl');
  try {
    await mkdir(wantedDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });
    await writeFile(wanted, lines(turn1()));
    await writeFile(other, lines(turn1()));
    await writeFile(configPath, JSON.stringify({ qoderWatch: ['wanted-session', 'missing-session'] }));
    const targets = await loadQoderWatchTargets({ configPath, projectsDir: projects });
    assert.deepEqual(targets, [wanted]);

    const direct = await loadQoderWatchTargets({
      configPath,
      projectsDir: projects,
    });
    assert.ok(!direct.includes(other));

    const absoluteConfig = join(root, 'absolute.json');
    await writeFile(absoluteConfig, JSON.stringify({ qoderWatch: [other] }));
    assert.deepEqual(await loadQoderWatchTargets({ configPath: absoluteConfig, projectsDir: projects }), [other]);

    const delivered: TurnPayload[] = [];
    const watcher = new QoderWatcher({
      configPath,
      projectsDir: projects,
      cursorDir: join(root, 'cursors'),
      pollIntervalMs: 20,
      deliver: async (payload) => { delivered.push(payload); },
    });
    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();
    assert.equal(delivered.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing qoderWatch means no listening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-qoder-config-'));
  const configPath = join(root, 'config.json');
  try {
    await writeFile(configPath, JSON.stringify({ apiKey: 'synthetic-placeholder' }));
    assert.deepEqual(await loadQoderWatchTargets({ configPath, projectsDir: root }), []);
    const missing = await loadQoderWatchTargets({ configPath: join(root, 'absent.json'), projectsDir: root });
    assert.deepEqual(missing, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cursor file is written with restrictive permissions and stores parser state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-qoder-'));
  const file = join(root, 'synthetic-qoder-0001.jsonl');
  const cursorDir = join(root, 'cursors');
  try {
    await writeFile(file, lines(turn1()));
    const watcher = new QoderWatcher({
      targets: [file],
      cursorDir,
      pollIntervalMs: 20,
      deliver: async () => {},
    });
    await watcher.start();
    await new Promise((r) => setTimeout(r, 80));
    watcher.stop();
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(cursorDir);
    assert.equal(files.length, 1);
    const cursorPath = join(cursorDir, files[0]);
    const info = await stat(cursorPath);
    assert.equal(info.mode & 0o777, 0o600);
    const cursor = JSON.parse(await readFile(cursorPath, 'utf8')) as { offset: number; ino: number; parserState?: unknown };
    assert.ok(cursor.offset > 0);
    assert.ok(cursor.ino > 0);
    assert.ok(cursor.parserState);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});