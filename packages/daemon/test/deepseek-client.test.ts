import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTurn } from '@thought-atlas/core';
import type { ModelRequest } from '@thought-atlas/core';
import { DeepSeekClient } from '../src/deepseek-client.ts';

const REQUEST: ModelRequest = {
  system: '分析',
  user: '内容',
  jsonMode: true,
  temperature: 0.9,
  timeoutMs: 5000,
};

interface Stub {
  body: Record<string, unknown> | null;
  restore: () => void;
}

function stubFetch(respond: () => Response): Stub {
  const original = globalThis.fetch;
  const stub: Stub = { body: null, restore: () => { globalThis.fetch = original; } };
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    stub.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return respond();
  }) as typeof fetch;
  return stub;
}

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function client(model: string): DeepSeekClient {
  return new DeepSeekClient({ apiKey: 'test-key', baseUrl: 'https://api.invalid', model });
}

test('deepseek models send thinking disabled, json_object, clamped temperature', async () => {
  const stub = stubFetch(() => chatResponse('{"ops":[]}'));
  try {
    await client('deepseek-flash').complete(REQUEST);
    assert.deepEqual(stub.body?.thinking, { type: 'disabled' });
    assert.deepEqual(stub.body?.response_format, { type: 'json_object' });
    assert.equal(stub.body?.temperature, 0.3);
    assert.equal(stub.body?.stream, false);
  } finally {
    stub.restore();
  }
});

test('non-deepseek models omit thinking field and respect jsonMode off', async () => {
  const stub = stubFetch(() => chatResponse('ok'));
  try {
    await client('other-compatible').complete({ ...REQUEST, jsonMode: false });
    assert.equal('thinking' in (stub.body ?? {}), false);
    assert.equal('response_format' in (stub.body ?? {}), false);
  } finally {
    stub.restore();
  }
});

test('json mode with whitespace-only content fails so analyzer retries', async () => {
  const stub = stubFetch(() => chatResponse('    '));
  try {
    await assert.rejects(client('deepseek-flash').complete(REQUEST), /blank json content/);
  } finally {
    stub.restore();
  }
});

test('non-json mode allows whitespace-only content through', async () => {
  const stub = stubFetch(() => chatResponse('   '));
  try {
    const res = await client('deepseek-flash').complete({ ...REQUEST, jsonMode: false });
    assert.equal(res.text, '   ');
  } finally {
    stub.restore();
  }
});

test('non-ok HTTP status throws', async () => {
  const stub = stubFetch(() => new Response('{}', { status: 500 }));
  try {
    await assert.rejects(client('deepseek-flash').complete(REQUEST), /model HTTP 500/);
  } finally {
    stub.restore();
  }
});

test('blank json content triggers analyzer call-failure retry, second call succeeds', async () => {
  let calls = 0;
  const stub = stubFetch(() => {
    calls++;
    return calls === 1 ? chatResponse('   ') : chatResponse(JSON.stringify({ ops: [{ op: 'SKIP' }] }));
  });
  try {
    const result = await analyzeTurn({
      payload: {
        sessionId: 'blank-json', turnIndex: 1,
        userText: '我想理解一下递归调用栈为什么容易溢出',
        assistantText: '每层调用都会压栈保存局部变量和返回地址，层数深了就超出栈空间。',
        timestamp: new Date().toISOString(),
        source: 'sandbox',
      },
      skeleton: [],
      recentSummaries: [],
      model: client('deepseek-flash'),
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
  } finally {
    stub.restore();
  }
});