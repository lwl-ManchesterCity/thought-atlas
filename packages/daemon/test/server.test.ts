import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, access, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ModelClient, ModelRequest, ModelResponse, TurnPayload } from '@thought-atlas/core';
import { AtlasDaemon } from '../src/server.ts';
import { FsStorage } from '../src/fs-storage.ts';

class FakeModel implements ModelClient {
  fail = false;
  calls = 0;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls++;
    if (this.fail) throw new Error('simulated model outage');
    assert.equal(request.jsonMode, true);
    return {
      text: JSON.stringify({
        ops: [{ op: 'ADD_NODE', node: { type: 'claim', label: '浮点是精度取舍', summary: '浮点误差来自精度取舍而非 bug' } }],
      }),
      usage: { promptTokens: 10, completionTokens: 5 },
      latencyMs: 1,
    };
  }
}

function payload(turnIndex: number, overrides: Partial<TurnPayload> = {}): TurnPayload {
  return {
    sessionId: 'daemon-test-session',
    turnIndex,
    userText: '我一直以为浮点误差是实现里的 bug，今天想重新理解一下这个问题。',
    assistantText: '浮点误差本质是有限位数表示实数时的精度取舍，IEEE754 定义了舍入规则。',
    timestamp: new Date().toISOString(),
    source: 'sandbox',
    ...overrides,
  };
}

interface Harness {
  daemon: AtlasDaemon;
  model: FakeModel;
  home: string;
  base: string;
  cleanup: () => Promise<void>;
}

async function setup(options: { webDir?: string } = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'atlas-daemon-test-'));
  const model = new FakeModel();
  const daemon = new AtlasDaemon({
    model,
    home,
    port: 0,
    retryIntervalMs: 3_600_000,
    storageFactory: (sessionId) => new FsStorage(sessionId, home),
    webDir: options.webDir,
  });
  const port = await daemon.start();
  const base = `http://127.0.0.1:${port}`;
  return {
    daemon,
    model,
    home,
    base,
    cleanup: async () => {
      await daemon.stop();
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function postTurn(base: string, p: TurnPayload): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getMap(base: string, sessionId: string): Promise<{ nodes: unknown[]; lastTurn: number }> {
  const res = await fetch(`${base}/map?sessionId=${sessionId}`);
  assert.equal(res.status, 200);
  return (await res.json()) as { nodes: unknown[]; lastTurn: number };
}

test('POST /turn applies ops, GET /map reflects graph, SSE broadcasts update', async () => {
  const h = await setup();
  try {
    const sse = await fetch(`${h.base}/events`);
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntilData = async (): Promise<string> => {
      for (;;) {
        const idx = buffer.indexOf('data: ');
        if (idx >= 0) {
          const end = buffer.indexOf('\n\n', idx);
          if (end >= 0) {
            const line = buffer.slice(idx + 6, end);
            buffer = buffer.slice(end + 2);
            return line;
          }
        }
        const { value, done } = await reader.read();
        assert.equal(done, false);
        buffer += decoder.decode(value, { stream: true });
      }
    };

    const result = await postTurn(h.base, payload(1));
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'applied');

    const map = await getMap(h.base, 'daemon-test-session');
    assert.equal(map.nodes.length, 1);
    assert.equal(map.lastTurn, 1);

    const event = JSON.parse(await readUntilData()) as { sessionId: string; turnIndex: number; map: { nodes: unknown[] } };
    assert.equal(event.sessionId, 'daemon-test-session');
    assert.equal(event.turnIndex, 1);
    assert.equal(event.map.nodes.length, 1);
    await reader.cancel();
  } finally {
    await h.cleanup();
  }
});

test('duplicate delivery leaves map and event log unchanged', async () => {
  const h = await setup();
  try {
    const first = await postTurn(h.base, payload(1));
    assert.equal(first.body.status, 'applied');
    const second = await postTurn(h.base, payload(1));
    assert.equal(second.body.status, 'duplicate');
    const map = await getMap(h.base, 'daemon-test-session');
    assert.equal(map.nodes.length, 1);
    const events = await readFile(join(h.home, 'sessions', 'daemon-test-session', 'events.jsonl'), 'utf8');
    assert.equal(events.trim().split('\n').length, 1);
    assert.equal(h.model.calls, 1);
  } finally {
    await h.cleanup();
  }
});

test('analyzer failure queues retry, recovery re-run applies and clears queue', async () => {
  const h = await setup();
  try {
    h.model.fail = true;
    const failed = await postTurn(h.base, payload(1));
    assert.equal(failed.body.status, 'retry_queued');
    assert.equal((await getMap(h.base, 'daemon-test-session')).nodes.length, 0);

    const retryPath = join(h.home, 'sessions', 'daemon-test-session', 'retry.jsonl');
    const queued = (await readFile(retryPath, 'utf8')).trim().split('\n');
    assert.equal(queued.length, 1);
    const failures = await readFile(join(h.home, 'sessions', 'daemon-test-session', 'failures.jsonl'), 'utf8');
    assert.match(failures, /simulated model outage/);

    h.model.fail = false;
    const stats = await h.daemon.runRetryOnce();
    assert.equal(stats.recovered, 1);
    assert.equal(stats.failed, 0);
    const map = await getMap(h.base, 'daemon-test-session');
    assert.equal(map.nodes.length, 1);
    await assert.rejects(access(retryPath));
  } finally {
    await h.cleanup();
  }
});

test('retry attempts are capped and exhausted entries move to failures', async () => {
  const home = await mkdtemp(join(tmpdir(), 'atlas-daemon-test-'));
  const model = new FakeModel();
  model.fail = true;
  const daemon = new AtlasDaemon({
    model,
    home,
    port: 0,
    retryIntervalMs: 3_600_000,
    maxRetryAttempts: 2,
    storageFactory: (sessionId) => new FsStorage(sessionId, home),
  });
  const port = await daemon.start();
  const base = `http://127.0.0.1:${port}`;
  try {
    await postTurn(base, payload(1));
    const first = await daemon.runRetryOnce();
    assert.equal(first.failed, 1);
    const second = await daemon.runRetryOnce();
    assert.equal(second.exhausted, 1);
    const retryPath = join(home, 'sessions', 'daemon-test-session', 'retry.jsonl');
    await assert.rejects(access(retryPath));
    const failures = await readFile(join(home, 'sessions', 'daemon-test-session', 'failures.jsonl'), 'utf8');
    assert.match(failures, /retry exhausted/);
  } finally {
    await daemon.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('ack-only turn is skipped without model call', async () => {
  const h = await setup();
  try {
    const result = await postTurn(h.base, payload(1, { userText: '好的，继续', assistantText: '' }));
    assert.equal(result.body.status, 'skipped');
    assert.equal(h.model.calls, 0);
    const map = await getMap(h.base, 'daemon-test-session');
    assert.equal(map.nodes.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('invalid payload and unknown routes are rejected without crashing', async () => {
  const h = await setup();
  try {
    const bad = await postTurn(h.base, payload(0));
    assert.equal(bad.status, 400);
    const badSource = await postTurn(h.base, payload(1, { source: 'unknown' as TurnPayload['source'] }));
    assert.equal(badSource.status, 400);
    const notJson = await fetch(`${h.base}/turn`, { method: 'POST', body: 'not json' });
    assert.equal(notJson.status, 400);
    const wrongMethod = await fetch(`${h.base}/turn`);
    assert.equal(wrongMethod.status, 404);
    const unknown = await fetch(`${h.base}/nope`);
    assert.equal(unknown.status, 404);
    const health = await fetch(`${h.base}/health`);
    assert.equal(health.status, 200);
  } finally {
    await h.cleanup();
  }
});
test('GET / serves web build only from whitelist and blocks traversal', async () => {
  const webDir = await mkdtemp(join(tmpdir(), 'atlas-web-test-'));
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>atlas-fixture</title>');
  await writeFile(join(webDir, 'app.js'), 'console.log(1);');
  await writeFile(join(webDir, 'styles.css'), 'body{}');
  const h = await setup({ webDir });
  try {
    const index = await fetch(`${h.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await index.text(), /atlas-fixture/);

    const script = await fetch(`${h.base}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);

    const style = await fetch(`${h.base}/styles.css`);
    assert.equal(style.status, 200);

    const traversal = await fetch(`${h.base}/%2e%2e%2fpackage.json`);
    assert.equal(traversal.status, 404);
    const missing = await fetch(`${h.base}/missing.js`);
    assert.equal(missing.status, 404);
  } finally {
    await h.cleanup();
    await rm(webDir, { recursive: true, force: true });
  }
});

test('static routes 404 when webDir is not configured', async () => {
  const h = await setup();
  try {
    const res = await fetch(`${h.base}/`);
    assert.equal(res.status, 404);
  } finally {
    await h.cleanup();
  }
});

test('GET /sessions lists maps newest first with counts', async () => {
  const h = await setup();
  try {
    const older = {
      sessionId: 'session-older',
      lastTurn: 3,
      nodes: [],
      edges: [],
    };
    const newer = {
      sessionId: 'session-newer',
      lastTurn: 5,
      nodes: [{ id: 'n_0001' }],
      edges: [],
    };
    await mkdir(join(h.home, 'sessions', 'session-older'), { recursive: true });
    await mkdir(join(h.home, 'sessions', 'session-newer'), { recursive: true });
    const olderPath = join(h.home, 'sessions', 'session-older', 'map.json');
    const newerPath = join(h.home, 'sessions', 'session-newer', 'map.json');
    await writeFile(olderPath, JSON.stringify(older));
    await writeFile(newerPath, JSON.stringify(newer));
    await utimes(olderPath, new Date('2026-11-20T00:00:00Z'), new Date('2026-11-20T00:00:00Z'));
    await utimes(newerPath, new Date('2026-11-22T00:00:00Z'), new Date('2026-11-22T00:00:00Z'));

    const res = await fetch(`${h.base}/sessions`);
    assert.equal(res.status, 200);
    const list = (await res.json()) as {
      sessionId: string;
      lastTurn: number;
      nodes: number;
      edges: number;
      updatedAt: string;
    }[];
    assert.deepEqual(
      list.map((s) => s.sessionId),
      ['session-newer', 'session-older'],
    );
    assert.equal(list[0].nodes, 1);
    assert.equal(list[1].lastTurn, 3);
  } finally {
    await h.cleanup();
  }
});
