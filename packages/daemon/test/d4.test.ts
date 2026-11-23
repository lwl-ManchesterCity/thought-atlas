import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GraphMap, ModelClient, ModelRequest, ModelResponse, ThoughtEdge, ThoughtNode } from '@thought-atlas/core';
import { ThoughtGraph } from '@thought-atlas/core';
import { AtlasDaemon } from '../src/server.ts';
import { FsStorage } from '../src/fs-storage.ts';

class TurnModel implements ModelClient {
  calls = 0;
  fail = false;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls++;
    if (this.fail) throw new Error('simulated naming outage');
    assert.equal(request.jsonMode, true);
    if (request.system.includes('簇命名器')) {
      const lines = request.user.split('\n').slice(1).filter(Boolean);
      const names = lines.map((line) => {
        const parsed = JSON.parse(line) as { key: string; labels: string[] };
        return { key: parsed.key, label: `主题${parsed.labels[0]?.slice(-2) ?? 'X'}` };
      });
      return {
        text: JSON.stringify({ names }),
        usage: { promptTokens: 8, completionTokens: 4 },
        latencyMs: 2,
      };
    }
    return {
      text: JSON.stringify({
        ops: [{ op: 'ADD_NODE', node: { type: 'claim', label: '浮点是精度取舍', summary: '浮点误差来自精度取舍而非 bug' } }],
      }),
      usage: { promptTokens: 10, completionTokens: 5 },
      latencyMs: 1,
    };
  }
}

function node(id: string, type: ThoughtNode['type'] = 'claim', label = id): ThoughtNode {
  return {
    id,
    type,
    owner: type === 'ai-voice' ? 'ai' : 'user',
    label,
    summary: `${label}摘要`,
    bornTurn: 1,
    lastTurn: 1,
    rings: [1],
    status: 'active',
    supersededBy: null,
    mergedInto: null,
    anchorTurns: [1],
    clusterId: null,
    manual: false,
  };
}

function edge(from: string, to: string, kind: ThoughtEdge['kind'] = 'related'): ThoughtEdge {
  return { from, to, kind, bornTurn: 1 };
}

interface Harness {
  daemon: AtlasDaemon;
  model: TurnModel;
  home: string;
  base: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'atlas-d4-test-'));
  const model = new TurnModel();
  const daemon = new AtlasDaemon({
    model,
    home,
    port: 0,
    retryIntervalMs: 3_600_000,
    storageFactory: (id) => new FsStorage(id, home),
  });
  const port = await daemon.start();
  return {
    daemon,
    model,
    home,
    base: `http://127.0.0.1:${port}`,
    cleanup: async () => {
      await daemon.stop();
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getJson<T>(base: string, path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function postTurn(base: string, sessionId: string, turnIndex: number, userText: string): Promise<void> {
  const res = await fetch(`${base}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      turnIndex,
      userText,
      assistantText: '助手回答：先放到合成夹具里。',
      timestamp: new Date().toISOString(),
      source: 'sandbox',
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.ok(body.status === 'applied' || body.status === 'skipped');
}

test('GET /replay lists steps/events and snapshot folds by turn', async () => {
  const h = await setup();
  const session = 'replay-test';
  try {
    await postTurn(h.base, session, 1, '我先认为浮点误差是语言的 bug，想验证一下。');
    await postTurn(h.base, session, 2, '现在理解成精度取舍，不是 bug。');

    const replay = await getJson<{ steps: { turnIndex: number; manual: boolean; opsCount: number }[]; events: unknown[]; lastTurn: number }>(
      h.base,
      `/replay?sessionId=${session}`,
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.steps.length, 2);
    assert.equal(replay.body.steps[0].turnIndex, 1);
    assert.equal(replay.body.steps[0].manual, false);
    assert.equal(replay.body.events.length, 2);

    const at1 = await getJson<{ map: GraphMap }>(h.base, `/replay/snapshot?sessionId=${session}&turn=1`);
    assert.equal(at1.body.map.nodes.length, 1);
    const full = await getJson<{ map: GraphMap }>(h.base, `/replay/snapshot?sessionId=${session}`);
    assert.equal(full.body.map.nodes.length, 2);
    assert.equal(full.body.map.lastTurn, 2);

    const bad = await fetch(`${h.base}/replay/snapshot?sessionId=${session}&turn=0`);
    assert.equal(bad.status, 400);
    const badSession = await fetch(`${h.base}/replay?sessionId=../etc`);
    assert.equal(badSession.status, 400);
  } finally {
    await h.cleanup();
  }
});

test('GET /anchors returns synthetic local turn text by node anchorTurns', async () => {
  const h = await setup();
  const session = 'anchor-test';
  try {
    await postTurn(h.base, session, 1, '合成锚点：这是用户第一轮的原话。');
    const map = await getJson<GraphMap>(h.base, `/map?sessionId=${session}`);
    const nodeId = map.body.nodes[0].id;

    const anchors = await getJson<{
      found: boolean;
      anchorTurns: number[];
      turns: { turnIndex: number; userText: string; assistantText: string }[];
    }>(h.base, `/anchors?sessionId=${session}&nodeId=${nodeId}`);
    assert.equal(anchors.status, 200);
    assert.equal(anchors.body.found, true);
    assert.deepEqual(anchors.body.anchorTurns, [1]);
    assert.equal(anchors.body.turns.length, 1);
    assert.match(anchors.body.turns[0].userText, /合成锚点/);
    assert.match(anchors.body.turns[0].assistantText, /合成夹具/);

    const explicit = await getJson<{ turns: unknown[] }>(
      h.base,
      `/anchors?sessionId=${session}&nodeId=${nodeId}&turns=1`,
    );
    assert.equal(explicit.body.turns.length, 1);
    const bad = await fetch(`${h.base}/anchors?sessionId=${session}&nodeId=..%2F`);
    assert.equal(bad.status, 400);
  } finally {
    await h.cleanup();
  }
});

test('GET /clusters falls back to 簇 #n, refresh names via model, failure stays fallback', async () => {
  const h = await setup();
  try {
    const storage = new FsStorage('cluster-test', h.home);
    await storage.saveMap({
      sessionId: 'cluster-test',
      nodes: [node('n_0001', 'claim', '浮点误差'), node('n_0002', 'claim', '精度取舍'), node('n_0003')],
      edges: [edge('n_0001', 'n_0002')],
      lastTurn: 1,
    });
    const initial = await getJson<{ clusters: { key: string; label: string; named: boolean; size: number }[]; isolated: string[] }>(
      h.base,
      '/clusters?sessionId=cluster-test',
    );
    assert.equal(initial.status, 200);
    assert.equal(initial.body.clusters.length, 1);
    assert.equal(initial.body.clusters[0].size, 2);
    assert.equal(initial.body.clusters[0].label, '簇 #1');
    assert.equal(initial.body.clusters[0].named, false);
    assert.deepEqual(initial.body.isolated, ['n_0003']);

    const refreshed = await postJson(h.base, '/clusters/refresh', { sessionId: 'cluster-test' });
    assert.equal(refreshed.status, 200);
    const namedClusters = refreshed.body.clusters as { key: string; label: string; named: boolean }[];
    assert.equal(namedClusters[0].named, true);
    assert.notEqual(namedClusters[0].label, '簇 #1');

    const second = await getJson<{ clusters: { label: string; named: boolean }[] }>(h.base, '/clusters?sessionId=cluster-test');
    assert.equal(second.body.clusters[0].named, true);
    assert.equal(second.body.clusters[0].label, namedClusters[0].label);

    const storage2 = new FsStorage('cluster-fail', h.home);
    await storage2.saveMap({
      sessionId: 'cluster-fail',
      nodes: [node('n_0001', 'claim', '甲'), node('n_0002', 'claim', '乙')],
      edges: [edge('n_0001', 'n_0002')],
      lastTurn: 1,
    });
    h.model.fail = true;
    const failed = await postJson(h.base, '/clusters/refresh', { sessionId: 'cluster-fail' });
    assert.equal(failed.status, 200);
    assert.equal((failed.body.clusters as { label: string; named: boolean }[])[0].label, '簇 #1');
    assert.equal((failed.body.clusters as { label: string; named: boolean }[])[0].named, false);
  } finally {
    await h.cleanup();
  }
});

test('POST /manual appends reversible manual ops and replay reflects them', async () => {
  const h = await setup();
  const session = 'manual-test';
  try {
    const storage = new FsStorage(session, h.home);
    const graph = new ThoughtGraph(session, storage);
    await graph.applyTurn(
      1,
      [
        { op: 'ADD_NODE', node: { type: 'claim', label: '旧观点', summary: '旧观点' } },
        { op: 'ADD_NODE', node: { type: 'ai-voice', label: 'AI观点', summary: 'AI观点' } },
        {
          op: 'ADD_NODE',
          node: { type: 'claim', label: '待删除', summary: '待删除' },
          edges: [{ from: '@prev', to: '@new', kind: 'related', bornTurn: 1 }],
        },
      ],
      new Date().toISOString(),
    );

    const marked = await postJson(h.base, '/manual', { sessionId: session, action: 'mark-shift', nodeId: 'n_0001' });
    assert.equal(marked.status, 200);
    assert.equal(marked.body.turnIndex, 1_000_000);
    const markedNode = (marked.body.map as GraphMap).nodes.find((n) => n.id === 'n_0001');
    assert.equal(markedNode?.type, 'shift');
    assert.equal(markedNode?.manual, true);
    assert.equal((marked.body.map as GraphMap).lastTurn, 1);

    const replay = await getJson<{ steps: { manual: boolean }[] }>(h.base, `/replay?sessionId=${session}`);
    assert.equal(replay.body.steps.length, 2);
    assert.equal(replay.body.steps[0].manual, false);
    assert.equal(replay.body.steps[1].manual, true);

    const snapshot = await getJson<{ map: GraphMap }>(h.base, `/replay/snapshot?sessionId=${session}`);
    assert.equal(snapshot.body.map.nodes.find((n) => n.id === 'n_0001')?.type, 'shift');

    const deleted = await postJson(h.base, '/manual', { sessionId: session, action: 'delete', nodeId: 'n_0003' });
    assert.equal(deleted.status, 200);
    assert.equal((deleted.body.map as GraphMap).nodes.some((n) => n.id === 'n_0003'), false);
    const after = await getJson<{ map: GraphMap }>(h.base, `/replay/snapshot?sessionId=${session}`);
    assert.equal(after.body.map.nodes.some((n) => n.id === 'n_0003'), false);
    const edgesAfter = after.body.map.edges;
    assert.equal(edgesAfter.length, 0);

    const aiShift = await postJson(h.base, '/manual', { sessionId: session, action: 'mark-shift', nodeId: 'n_0002' });
    assert.equal(aiShift.status, 409);
    const missing = await postJson(h.base, '/manual', { sessionId: session, action: 'delete', nodeId: 'n_9999' });
    assert.equal(missing.status, 404);
    const badAction = await postJson(h.base, '/manual', { sessionId: session, action: 'drop', nodeId: 'n_0001' });
    assert.equal(badAction.status, 400);
    const badSession = await postJson(h.base, '/manual', { sessionId: '../x', action: 'delete', nodeId: 'n_0001' });
    assert.equal(badSession.status, 400);

    const events = (await readFile(join(h.home, 'sessions', session, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { turnIndex: number; ops: { op: string; manual?: boolean }[] });
    const manualEvents = events.filter((event) => event.turnIndex >= 1_000_000);
    assert.equal(manualEvents.length, 2);
    assert.equal(manualEvents[0].ops[0].op, 'MARK_SHIFT');
    assert.equal(manualEvents[0].ops[0].manual, true);
    assert.equal(manualEvents[1].ops[0].op, 'DELETE');
  } finally {
    await h.cleanup();
  }
});