import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolloutParser, RolloutCursorReader, sessionIdFromRolloutPath } from '../src/index.ts';
import type { TurnPayload } from '@thought-atlas/core';
import { SESSION_ID, fullFixture, meta, turn1, turn2, taskComplete } from './fixtures.ts';

function parseAll(records: ReturnType<typeof fullFixture>) {
  const parser = new RolloutParser();
  return records.map((r) => parser.feed(r)).filter((p) => p !== null);
}

test('parses two turns with correct session, index, and texts', () => {
  const turns = parseAll(fullFixture());
  assert.equal(turns.length, 2);
  assert.equal(turns[0].sessionId, SESSION_ID);
  assert.equal(turns[0].turnIndex, 1);
  assert.equal(turns[0].source, 'codex');
  assert.equal(turns[0].userText, '我觉得递归就是函数自己调用自己，没什么难的');
  assert.ok(turns[0].assistantText.includes('隐式调用栈'));
  assert.equal(turns[0].timestamp, '2026-11-23T02:01:00.000Z');
  assert.equal(turns[1].turnIndex, 2);
  assert.ok(turns[1].userText.includes('我之前想简单了'));
});

test('developer role and all tool records are excluded', () => {
  const turns = parseAll(fullFixture());
  for (const t of turns) {
    assert.ok(!t.userText.includes('环境注入'));
    assert.ok(!t.userText.includes('environment_context'));
    assert.ok(!t.assistantText.includes('synthetic-tool'));
    assert.ok(!t.assistantText.includes('synthetic-function'));
    assert.ok(!t.assistantText.includes('推理过程'));
  }
});

test('assistant text falls back to last_agent_message', () => {
  const parser = new RolloutParser();
  parser.feed(meta());
  parser.feed({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '合成问题：什么是尾递归？' }] } });
  const turn = parser.feed(taskComplete('tX', '合成最终回复：尾递归是最后一步动作即递归调用。'));
  assert.ok(turn);
  assert.equal(turn.assistantText, '合成最终回复：尾递归是最后一步动作即递归调用。');
});

test('duplicate turn_id is deduplicated', () => {
  const parser = new RolloutParser();
  for (const r of [meta(), ...turn1()]) parser.feed(r);
  const dup = parser.feed(taskComplete('t1', '重复投递'));
  assert.equal(dup, null);
});

test('empty task_complete still advances turnIndex (不重不漏)', () => {
  const parser = new RolloutParser();
  parser.feed(meta());
  const empty = parser.feed(taskComplete('t-empty', ''));
  assert.ok(empty);
  assert.equal(empty.turnIndex, 1);
  assert.equal(empty.userText, '');
  const next = parser.feed(taskComplete('t-next', '合成回复'));
  assert.equal(next?.turnIndex, 2);
});

test('malformed lines are skipped silently', () => {
  const parser = new RolloutParser();
  assert.equal(parser.feedLine('{broken json'), null);
  assert.equal(parser.feedLine(''), null);
  parser.feedLine(JSON.stringify(meta()));
  const turn = parser.feedLine(JSON.stringify(taskComplete('t1', '合成回复')));
  assert.ok(turn);
});

test('user message that is only wrappers produces no user text', () => {
  const parser = new RolloutParser();
  parser.feed(meta());
  parser.feed({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>只有环境信息</environment_context>' }] } });
  const turn = parser.feed(taskComplete('t1', '合成回复'));
  assert.equal(turn?.userText, '');
});

test('byte cursor reads only new complete lines across appends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-rollout-'));
  const file = join(dir, 'rollout-synthetic.jsonl');
  try {
    const records = [meta(), ...turn1(), ...turn2()];
    const lines = records.map((r) => JSON.stringify(r));
    await writeFile(file, lines.slice(0, 4).join('\n') + '\n');
    const reader = new RolloutCursorReader(file);
    const parser = new RolloutParser();

    const emitted: number[] = [];
    const consume = async () => {
      for (const line of await reader.readNewLines()) {
        const turn = parser.feedLine(line);
        if (turn) emitted.push(turn.turnIndex);
      }
    };

    await consume();
    assert.deepEqual(emitted, []);

    const rest = lines.slice(4).join('\n') + '\n';
    const splitAt = Math.floor(rest.length / 2);
    await appendFile(file, rest.slice(0, splitAt));
    await consume();
    const posMid = reader.position;
    await appendFile(file, rest.slice(splitAt));
    await consume();
    assert.deepEqual(emitted, [1, 2]);
    assert.ok(reader.position > posMid);
    assert.deepEqual(await reader.readNewLines(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('partial trailing line is not consumed until newline arrives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-rollout-'));
  const file = join(dir, 'rollout-synthetic.jsonl');
  try {
    const line = JSON.stringify(meta());
    await writeFile(file, line.slice(0, 20));
    const reader = new RolloutCursorReader(file);
    assert.deepEqual(await reader.readNewLines(), []);
    assert.equal(reader.position, 0);
    await appendFile(file, line.slice(20) + '\n');
    const lines = await reader.readNewLines();
    assert.equal(lines.length, 1);
    assert.equal(reader.position, Buffer.byteLength(line) + 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('truncated file resets cursor and turn dedup prevents double delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-rollout-'));
  const file = join(dir, 'rollout-synthetic.jsonl');
  try {
    const records = [meta(), ...turn1()];
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const reader = new RolloutCursorReader(file);
    const parser = new RolloutParser();
    let count = 0;
    for (const line of await reader.readNewLines()) if (parser.feedLine(line)) count++;
    assert.equal(count, 1);

    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    for (const line of await reader.readNewLines()) if (parser.feedLine(line)) count++;
    assert.equal(count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('sessionId override wins over session_meta (continuation rollouts share thread id)', () => {
  const parser = new RolloutParser({ sessionId: 'per-file-session' });
  const turns: TurnPayload[] = [];
  for (const record of fullFixture()) {
    const turn = parser.feed(record);
    if (turn) turns.push(turn);
  }
  assert.equal(turns.length, 2);
  assert.ok(turns.every((t) => t.sessionId === 'per-file-session'));
});

test('sessionIdFromRolloutPath derives stable unique id from filename', () => {
  assert.equal(
    sessionIdFromRolloutPath('/x/sessions/2026/11/19/rollout-2026-11-19T19-35-57-aaaa_bbbb.jsonl'),
    '2026-11-19T19-35-57-aaaa_bbbb',
  );
  assert.equal(sessionIdFromRolloutPath('/x/rollout-plain.jsonl'), 'plain');
});
