import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldEvents } from '../functions/lib/core/index.ts';
import type { GraphMap, EventRecord } from '../functions/lib/core/types.ts';
import { application } from '../functions/lib/routes.ts';
import { cacheKey, utcDay } from '../functions/lib/limits.ts';
import { MemoryDb } from '../dev/memory-db.ts';
import { StubModel } from '../dev/stub-model.ts';

const NOW = new Date('2026-11-23T06:00:00.000Z');

function setup(model: StubModel | null = new StubModel()) {
  const db = new MemoryDb();
  const handler = application({ db, model, now: () => NOW });
  return { db, model, handler };
}

function post(handler: (request: Request) => Promise<Response>, path: string, body: unknown, ip = '203.0.113.7') {
  return handler(
    new Request(`http://local/functions/v1/app${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

function get(handler: (request: Request) => Promise<Response>, path: string, ip = '203.0.113.7') {
  return handler(
    new Request(`http://local/functions/v1/app${path}`, { headers: { 'x-forwarded-for': ip } }),
  );
}

async function newSession(handler: (request: Request) => Promise<Response>, ip = '203.0.113.7'): Promise<string> {
  const res = await post(handler, '/api/sandbox/session', {}, ip);
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

test('missing Secret fails closed without model calls or stored text', async () => {
  const { db, handler } = setup(null);
  const sessionId = await newSession(handler);
  const text = '秘密原文不应落库：请解释浮点误差为什么不是 bug';
  const res = await post(handler, '/api/sandbox/turn', { sessionId, text });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'service_not_configured');
  assert.equal(JSON.stringify(db.tables).includes(text), false);
  assert.equal(db.dump('analysis_cache').length, 0);
});

test('per-IP daily session cap is two', async () => {
  const { handler } = setup();
  for (let i = 0; i < 2; i++) {
    const res = await post(handler, '/api/sandbox/session', {}, '198.51.100.4');
    assert.equal(res.status, 201);
  }
  const blocked = await post(handler, '/api/sandbox/session', {}, '198.51.100.4');
  assert.equal(blocked.status, 429);
  assert.equal(((await blocked.json()) as { error: string }).error, 'session_limit');
  const otherIp = await post(handler, '/api/sandbox/session', {}, '198.51.100.5');
  assert.equal(otherIp.status, 201);
});

test('turn applies nodes, records hashes only, and does not persist original text', async () => {
  const { db, model, handler } = setup();
  const sessionId = await newSession(handler);
  const userText = '我原来以为浮点误差是 JS 的 bug，现在想听听 IEEE754 的解释';
  const reply1 = await post(handler, '/api/sandbox/turn', { sessionId, text: userText });
  assert.equal(reply1.status, 200);
  const body1 = (await reply1.json()) as { map: GraphMap; turnIndex: number; reply: string };
  assert.equal(body1.turnIndex, 1);
  assert.equal(body1.map.nodes.length, 1);

  const reply2 = await post(handler, '/api/sandbox/turn', { sessionId, text: '那银行系统为什么不用浮点数存钱？' });
  assert.equal(reply2.status, 200);
  const body2 = (await reply2.json()) as { map: GraphMap; turnIndex: number };
  assert.equal(body2.turnIndex, 2);
  assert.equal(body2.map.nodes.length, 2);
  assert.equal(model!.chatCalls, 2);
  assert.equal(model!.completeCalls, 2);

  const rows = db.dump('sandbox_turns');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => typeof row.input_hash === 'string' && !('text' in row)));
  const serialized = JSON.stringify(db.tables);
  assert.equal(serialized.includes(userText), false);
  assert.equal(serialized.includes(body1.reply), false);
  assert.equal(serialized.includes(db.dump('graph_failures').length ? '\u0000' : 'no-such-text'), false);
});

test('identical input with unchanged skeleton hits cache without model calls', async () => {
  const model = new StubModel();
  model.analyzerText = () => JSON.stringify({ ops: [{ op: 'SKIP' }] });
  const { model: m, handler } = setup(model);
  const sessionId = await newSession(handler);
  const text = '这一轮只是确认，没有新观点';
  const first = await post(handler, '/api/sandbox/turn', { sessionId, text });
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as { status: string }).status, 'skipped');

  const second = await post(handler, '/api/sandbox/turn', { sessionId, text });
  assert.equal(second.status, 200);
  const body = (await second.json()) as { status: string; analysis: { modelUsed: boolean; cached: boolean } };
  assert.equal(body.status, 'cache_hit');
  assert.equal(body.analysis.modelUsed, false);
  assert.equal(body.analysis.cached, true);
  assert.equal(m!.chatCalls, 1);
  assert.equal(m!.completeCalls, 1);
});

test('daily quota circuit breaker returns friendly message and cache still works', async () => {
  const { db, handler } = setup();
  db.tables.daily_counters.push({
    day: utcDay(NOW),
    model_calls: 100,
    updated_at: NOW.toISOString(),
  });
  const sessionId = await newSession(handler);
  const blocked = await post(handler, '/api/sandbox/turn', { sessionId, text: '这一轮应该被总额度拦住' });
  assert.equal(blocked.status, 429);
  const blockedBody = (await blocked.json()) as { error: string; message: string };
  assert.equal(blockedBody.error, 'quota_exhausted');
  assert.match(blockedBody.message, /今日额度已用完/);

  const text = '这一条已经在缓存里';
  const key = await cacheKey(text, []);
  db.tables.analysis_cache.push({
    cache_key: key.key,
    ops: [{ op: 'SKIP' }],
    source_turn: 1,
    created_at: NOW.toISOString(),
  });
  const cached = await post(handler, '/api/sandbox/turn', { sessionId, text });
  assert.equal(cached.status, 200);
  assert.equal(((await cached.json()) as { status: string }).status, 'cache_hit');
});

test('input over 2000 characters is rejected before reserving a turn', async () => {
  const { db, handler } = setup();
  const sessionId = await newSession(handler);
  const res = await post(handler, '/api/sandbox/turn', { sessionId, text: '字'.repeat(2001) });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, 'text_too_long');
  assert.equal(db.dump('sandbox_turns').length, 0);
});

test('out-of-schema analyzer output is discarded whole and marked failed', async () => {
  const model = new StubModel();
  model.analyzerText = () => '{"ops":[{"op":"ADD_NODE","node":{"type":"bogus","label":"x","summary":"y"}}]}';
  const { db, handler } = setup(model);
  const sessionId = await newSession(handler);
  const res = await post(handler, '/api/sandbox/turn', { sessionId, text: '请给一个越界输出' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; map: GraphMap };
  assert.equal(body.status, 'analysis_failed');
  assert.equal(body.map.nodes.length, 0);
  assert.equal(db.dump('graph_failures').length, 1);
  assert.equal(db.dump('analysis_cache').length, 0);
});

test('shift rule violation rejects the whole batch', async () => {
  const model = new StubModel();
  model.analyzerText = () => JSON.stringify({
    ops: [
      { op: 'ADD_NODE', node: { type: 'ai-voice', label: 'AI观点', summary: 'AI 的解释' } },
      {
        op: 'MARK_SHIFT',
        nodeId: null,
        shift: { fromNodeId: '@prev', toSummary: '错误地把 AI 节点当作旧观点', triggerNodeId: null },
      },
    ],
  });
  const { handler } = setup(model);
  const sessionId = await newSession(handler);
  const res = await post(handler, '/api/sandbox/turn', { sessionId, text: '请触发转变硬规则' });
  const body = (await res.json()) as { status: string; map: GraphMap };
  assert.equal(body.status, 'analysis_failed');
  assert.equal(body.map.nodes.length, 0);
});

test('per-session 15-turn cap', async () => {
  const { db, handler } = setup();
  const sessionId = await newSession(handler);
  const row = db.tables.sandbox_sessions.find((entry) => entry.id === sessionId)!;
  row.last_turn = 15;
  const res = await post(handler, '/api/sandbox/turn', { sessionId, text: '超过单会话上限' });
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as { error: string }).error, 'session_turn_limit');
});

test('session is bound to the creating IP', async () => {
  const { handler } = setup();
  const sessionId = await newSession(handler, '203.0.113.9');
  const res = await post(handler, '/api/sandbox/turn', { sessionId, text: '换个 IP 发消息' }, '203.0.113.10');
  assert.equal(res.status, 403);
});

test('stored events replay to the same map', async () => {
  const { db, handler } = setup();
  const sessionId = await newSession(handler);
  for (let i = 1; i <= 3; i++) {
    const res = await post(handler, '/api/sandbox/turn', { sessionId, text: `第 ${i} 轮：请继续分析这个合成话题` });
    assert.equal(res.status, 200);
  }
  const mapRow = db.tables.graph_maps.find((row) => row.session_id === sessionId)!;
  const live = mapRow.map as GraphMap;
  const events = db
    .dump('graph_events')
    .filter((row) => row.session_id === sessionId)
    .map((row) => ({ turnIndex: row.turn_index, timestamp: row.event_ts, ops: row.ops })) as EventRecord[];
  const replayed = foldEvents(sessionId, events);
  assert.deepEqual(replayed.nodes.map((n) => n.id).sort(), live.nodes.map((n) => n.id).sort());
  assert.equal(replayed.lastTurn, live.lastTurn);
});

test('selfcheck reports configured/reachable without exposing the key', async () => {
  const { handler } = setup();
  const res = await post(handler, '/api/selfcheck', {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.configured, true);
  assert.equal(body.reachable, true);
  assert.equal(JSON.stringify(body).includes('sk-'), false);

  const missing = setup(null);
  const missingRes = await post(missing.handler, '/api/selfcheck', {});
  assert.equal(missingRes.status, 200);
  assert.equal(((await missingRes.json()) as { configured: boolean }).configured, false);
});

test('GET session returns map for the owning IP only', async () => {
  const { handler } = setup();
  const sessionId = await newSession(handler);
  await post(handler, '/api/sandbox/turn', { sessionId, text: '先长一个节点' });
  const ok = await get(handler, `/api/sandbox/session?id=${sessionId}`);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { map: GraphMap };
  assert.equal(body.map.nodes.length, 1);
  const denied = await get(handler, `/api/sandbox/session?id=${sessionId}`, '203.0.113.99');
  assert.equal(denied.status, 403);
});

test('invalid JSON and oversized bodies are rejected', async () => {
  const { handler } = setup();
  const sessionId = await newSession(handler);
  const bad = await post(handler, '/api/sandbox/turn', '{not json');
  assert.equal(bad.status, 400);
  const big = await post(handler, '/api/sandbox/turn', { sessionId, text: 'x', padding: 'x'.repeat(9000) });
  assert.equal(big.status, 413);
});

test('health and selfcheck report the injected model label, never a hardcoded one', async () => {
  const db = new MemoryDb();
  const stubHandler = application({ db, model: new StubModel(), label: 'stub', stub: true, now: () => NOW });
  const health = (await (await get(stubHandler, '/api/health')).json()) as { configured: boolean; model: string; stub: boolean };
  assert.equal(health.configured, true);
  assert.equal(health.model, 'stub');
  assert.equal(health.stub, true);
  const check = (await (await post(stubHandler, '/api/selfcheck', {})).json()) as { model: string; stub: boolean };
  assert.equal(check.model, 'stub');
  assert.equal(check.stub, true);

  const hosted = application({ db: new MemoryDb(), model: new StubModel(), now: () => NOW });
  const hostedHealth = (await (await get(hosted, '/api/health')).json()) as { model: string; stub: boolean };
  assert.equal(hostedHealth.model, 'deepseek-flash');
  assert.equal(hostedHealth.stub, false);
});