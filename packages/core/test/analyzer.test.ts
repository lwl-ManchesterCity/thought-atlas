import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTurn,
  buildUserMessage,
  parseAnalyzerOutput,
  truncateMiddle,
  validateOpsShape,
} from '../src/index.ts';
import type { ModelClient, ModelRequest, ModelResponse, TurnPayload } from '../src/index.ts';

const payload: TurnPayload = {
  sessionId: 's1',
  turnIndex: 3,
  userText: '我一直以为浮点误差是 bug，现在明白是精度取舍了',
  assistantText: '是的，IEEE754 用有限二进制位近似十进制小数',
  timestamp: '2026-11-23T10:00:00.000Z',
  source: 'sandbox',
};

class FakeModel implements ModelClient {
  responses: (string | Error)[];
  calls: ModelRequest[] = [];

  constructor(responses: (string | Error)[]) {
    this.responses = responses;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('no fake response left');
    return { text: next, usage: { promptTokens: 100, completionTokens: 20 }, latencyMs: 5 };
  }
}

const VALID_OUTPUT = JSON.stringify({
  ops: [{ op: 'ADD_NODE', node: { type: 'question', label: '新问题', summary: '一个新问题' } }],
});

test('parseAnalyzerOutput rejects non-JSON', () => {
  const result = parseAnalyzerOutput('这不是 JSON');
  assert.equal(result.ok, false);
});

test('parseAnalyzerOutput rejects code-fenced or prose-wrapped JSON', () => {
  assert.equal(parseAnalyzerOutput('```json\n{"ops":[{"op":"SKIP"}]}\n```').ok, false);
  assert.equal(parseAnalyzerOutput('好的，这是结果：{"ops":[{"op":"SKIP"}]}').ok, false);
});

test('parseAnalyzerOutput rejects wrong shapes', () => {
  assert.equal(parseAnalyzerOutput('{"ops":"SKIP"}').ok, false);
  assert.equal(parseAnalyzerOutput('{"ops":[]}').ok, false);
  assert.equal(parseAnalyzerOutput('{"ops":[{"op":"DROP_TABLE"}]}').ok, false);
  assert.equal(parseAnalyzerOutput('{"ops":[{"op":"ADD_NODE","node":{"type":"virus","label":"x","summary":"y"}}]}').ok, false);
  assert.equal(parseAnalyzerOutput('{"ops":[{"op":"REINFORCE","nodeId":"n_0001"}]}').ok, false);
  assert.equal(parseAnalyzerOutput('{"ops":[{"op":"SKIP"},{"op":"SKIP"}]}').ok, false);
});

test('parseAnalyzerOutput rejects more than 5 ops', () => {
  const ops = Array.from({ length: 6 }, () => ({ op: 'SKIP' }));
  assert.equal(parseAnalyzerOutput(JSON.stringify({ ops })).ok, false);
});

test('parseAnalyzerOutput accepts valid ops', () => {
  const result = parseAnalyzerOutput(VALID_OUTPUT);
  assert.equal(result.ok, true);
  const shift = parseAnalyzerOutput(JSON.stringify({
    ops: [{ op: 'MARK_SHIFT', nodeId: null, shift: { toSummary: '新立场', triggerNodeId: '@prev' } }],
  }));
  assert.equal(shift.ok, true);
});

test('validateOpsShape rejects UPDATE_NODE patch outside allowlist', () => {
  const result = validateOpsShape({
    ops: [{ op: 'UPDATE_NODE', nodeId: 'n_0001', patch: { status: 'merged' } }],
  });
  assert.equal(result.ok, false);
});

test('analyzeTurn discards invalid output as a whole, no retry', async () => {
  const model = new FakeModel(['{"ops":[{"op":"ADD_NODE","node":{"type":"claim"}}]}', VALID_OUTPUT]);
  const result = await analyzeTurn({ payload, skeleton: [], recentSummaries: [], model });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(model.calls.length, 1);
});

test('analyzeTurn retries once on model call failure then succeeds', async () => {
  const model = new FakeModel([new Error('timeout'), VALID_OUTPUT]);
  const result = await analyzeTurn({ payload, skeleton: [], recentSummaries: [], model });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(model.calls.length, 2);
});

test('analyzeTurn fails after two call failures', async () => {
  const model = new FakeModel([new Error('timeout'), new Error('timeout')]);
  const result = await analyzeTurn({ payload, skeleton: [], recentSummaries: [], model });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
});

test('analyzeTurn requests json mode and low temperature', async () => {
  const model = new FakeModel([VALID_OUTPUT]);
  await analyzeTurn({ payload, skeleton: [], recentSummaries: [], model });
  assert.equal(model.calls[0].jsonMode, true);
  assert.ok(model.calls[0].temperature <= 0.3);
  assert.equal(model.calls[0].timeoutMs, 20_000);
});

test('truncateMiddle keeps head and tail with marker', () => {
  const text = 'A'.repeat(3000) + 'B'.repeat(3000);
  const truncated = truncateMiddle(text, 4000);
  assert.ok(truncated.length <= 4000);
  assert.ok(truncated.startsWith('AAA'));
  assert.ok(truncated.endsWith('BBB'));
  assert.ok(truncated.includes('[已截断]'));
});

test('buildUserMessage wraps turn data in delimiters and applies budgets', () => {
  const longPayload = { ...payload, userText: '问'.repeat(9000), assistantText: '答'.repeat(9000) };
  const skeleton = Array.from({ length: 400 }, (_, i) => ({
    id: `n_${String(i + 1).padStart(4, '0')}`,
    type: 'claim' as const,
    label: `观点${i}`,
    summary: '这是一个比较长的观点概括'.repeat(3),
    lastTurn: i,
  }));
  const message = buildUserMessage({ payload: longPayload, skeleton, recentSummaries: [] });
  assert.ok(message.includes('<<<TURN_DATA>>>'));
  assert.ok(message.includes('<<<END_TURN_DATA>>>'));
  assert.ok(message.includes('[已截断]'));
  assert.ok(!message.includes('n_0001'));
  assert.ok(message.includes('n_0400'));
});