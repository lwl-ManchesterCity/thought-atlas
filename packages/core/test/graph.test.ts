import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThoughtGraph } from '../src/index.ts';
import type { MapOp } from '../src/index.ts';
import { MemoryStorage, TS } from './helpers.ts';

function addClaim(label: string, summary = label): MapOp {
  return { op: 'ADD_NODE', node: { type: 'claim', label, summary } };
}

test('ADD_NODE assigns id, initializes rings/anchors, materializes map and event', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  const result = await graph.applyTurn(1, [addClaim('浮点是精度取舍')], TS);
  assert.equal(result.ok, true);
  const map = graph.getMap();
  assert.equal(map.nodes.length, 1);
  const node = map.nodes[0];
  assert.equal(node.id, 'n_0001');
  assert.equal(node.bornTurn, 1);
  assert.deepEqual(node.rings, [1]);
  assert.deepEqual(node.anchorTurns, [1]);
  assert.equal(node.status, 'active');
  assert.equal(node.owner, 'user');
  assert.equal(storage.map?.nodes.length, 1);
  assert.equal(storage.events.length, 1);
  assert.equal(storage.events[0].turnIndex, 1);
});

test('label and summary are truncated to spec limits', async () => {
  const graph = new ThoughtGraph('s1', new MemoryStorage());
  const long = '一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾';
  await graph.applyTurn(1, [{ op: 'ADD_NODE', node: { type: 'fact', label: long, summary: long.repeat(4) } }], TS);
  const node = graph.getMap().nodes[0];
  assert.equal([...node.label].length, 16);
  assert.equal([...node.summary].length, 60);
});

test('REINFORCE adds ring without new node', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [addClaim('观点A')], TS);
  const result = await graph.applyTurn(2, [{ op: 'REINFORCE', nodeId: 'n_0001', turn: 2 }], TS);
  assert.equal(result.ok, true);
  const map = graph.getMap();
  assert.equal(map.nodes.length, 1);
  assert.deepEqual(map.nodes[0].rings, [1, 2]);
  assert.equal(map.nodes[0].lastTurn, 2);
});

test('duplicate turn delivery is idempotent', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [addClaim('观点A')], TS);
  const before = JSON.stringify(graph.getMap());
  const again = await graph.applyTurn(1, [addClaim('观点B')], TS);
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(JSON.stringify(graph.getMap()), before);
  assert.equal(storage.events.length, 1);
});

test('dangling reference rejects whole batch atomically', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  const result = await graph.applyTurn(1, [
    addClaim('合法节点'),
    { op: 'REINFORCE', nodeId: 'n_9999', turn: 1 },
  ], TS);
  assert.equal(result.ok, false);
  assert.equal(graph.getMap().nodes.length, 0);
  assert.equal(storage.events.length, 0);
  assert.equal(storage.map, null);
  assert.equal(storage.failures.length, 1);
  assert.equal(graph.isProcessed(1), false);
});

test('failed turn can be retried successfully', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [{ op: 'REINFORCE', nodeId: 'n_9999', turn: 1 }], TS);
  const retry = await graph.applyTurn(1, [addClaim('观点A')], TS);
  assert.equal(retry.ok, true);
  assert.equal(graph.getMap().nodes.length, 1);
});

test('more than 5 ops rejected', async () => {
  const graph = new ThoughtGraph('s1', new MemoryStorage());
  const ops: MapOp[] = Array.from({ length: 6 }, (_, i) => addClaim(`观点${i}`));
  const result = await graph.applyTurn(1, ops, TS);
  assert.equal(result.ok, false);
  assert.equal(graph.getMap().nodes.length, 0);
});

test('SKIP mixed with other ops rejected', async () => {
  const graph = new ThoughtGraph('s1', new MemoryStorage());
  const result = await graph.applyTurn(1, [{ op: 'SKIP' }, addClaim('观点A')], TS);
  assert.equal(result.ok, false);
});

test('MARK_SHIFT with @prev ai-voice creates shift and influence edge', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [addClaim('浮点是JS的bug')], TS);
  const result = await graph.applyTurn(2, [
    { op: 'ADD_NODE', node: { type: 'ai-voice', label: 'IEEE754解释', summary: 'AI解释精度取舍' }, edges: [] },
    {
      op: 'MARK_SHIFT', nodeId: null,
      shift: { fromNodeId: 'n_0001', toSummary: '浮点误差是精度取舍而非bug', triggerNodeId: '@prev', triggerTurn: 2 },
    },
  ], TS);
  assert.equal(result.ok, true);
  const map = graph.getMap();
  const shift = map.nodes.find((n) => n.type === 'shift');
  assert.ok(shift);
  assert.equal(shift.shift?.triggerNodeId, 'n_0002');
  assert.equal(shift.shift?.fromNodeId, 'n_0001');
  const influence = map.edges.find((e) => e.kind === 'influence');
  assert.deepEqual(influence, { from: 'n_0002', to: shift.id, kind: 'influence', bornTurn: 2 });
  const old = map.nodes.find((n) => n.id === 'n_0001');
  assert.equal(old?.status, 'superseded');
  assert.equal(old?.supersededBy, shift.id);
  assert.ok(map.edges.some((e) => e.kind === 'supersede' && e.from === 'n_0001' && e.to === shift.id));
});

test('MARK_SHIFT on existing node converts it to shift', async () => {
  const graph = new ThoughtGraph('s1', new MemoryStorage());
  await graph.applyTurn(1, [addClaim('旧立场')], TS);
  const result = await graph.applyTurn(2, [
    { op: 'MARK_SHIFT', nodeId: 'n_0001', shift: { toSummary: '新立场', retro: true } },
  ], TS);
  assert.equal(result.ok, true);
  const node = graph.getMap().nodes[0];
  assert.equal(node.type, 'shift');
  assert.equal(node.shift?.retro, true);
});

test('influence edge must go ai-voice -> shift', async () => {
  const graph = new ThoughtGraph('s1', new MemoryStorage());
  await graph.applyTurn(1, [addClaim('观点A'), addClaim('观点B')], TS);
  const result = await graph.applyTurn(2, [
    { op: 'ADD_EDGE', edge: { from: 'n_0001', to: 'n_0002', kind: 'influence', bornTurn: 2 } },
  ], TS);
  assert.equal(result.ok, false);
});

test('triggerNodeId must reference ai-voice', async () => {
  const graph = new ThoughtGraph('s1', new MemoryStorage());
  await graph.applyTurn(1, [addClaim('观点A')], TS);
  const result = await graph.applyTurn(2, [
    { op: 'MARK_SHIFT', nodeId: null, shift: { toSummary: '新立场', triggerNodeId: 'n_0001' } },
  ], TS);
  assert.equal(result.ok, false);
});

test('MARK_SHIFT fromNodeId must not reference ai-voice, batch stays atomic', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [
    addClaim('旧观点'),
    { op: 'ADD_NODE', node: { type: 'ai-voice', label: 'AI解释', summary: 'AI 的关键发言' } },
  ], TS);
  const before = structuredClone(graph.getMap());
  const result = await graph.applyTurn(2, [
    addClaim('本轮新观点'),
    { op: 'MARK_SHIFT', nodeId: null, shift: { fromNodeId: 'n_0002', toSummary: '新立场' } },
  ], TS);
  assert.equal(result.ok, false);
  assert.deepEqual(graph.getMap(), before);
  assert.equal(storage.events.length, 1);
});

test('ADD_NODE shift.fromNodeId must not reference ai-voice', async () => {
  const graph = new ThoughtGraph('s1', new MemoryStorage());
  await graph.applyTurn(1, [
    { op: 'ADD_NODE', node: { type: 'ai-voice', label: 'AI解释', summary: 'AI 的关键发言' } },
  ], TS);
  const result = await graph.applyTurn(2, [
    {
      op: 'ADD_NODE',
      node: {
        type: 'shift', label: '想通了', summary: '新立场',
        shift: { fromNodeId: 'n_0001', toSummary: '新立场' },
      },
    },
  ], TS);
  assert.equal(result.ok, false);
  assert.equal(graph.getMap().nodes.length, 1);
});

test('SUPERSEDE requires active nodes', async () => {
  const graph = new ThoughtGraph('s1', new MemoryStorage());
  await graph.applyTurn(1, [addClaim('旧'), addClaim('新')], TS);
  const ok = await graph.applyTurn(2, [{ op: 'SUPERSEDE', oldId: 'n_0001', newId: 'n_0002' }], TS);
  assert.equal(ok.ok, true);
  assert.equal(graph.getMap().nodes[0].status, 'superseded');
  const again = await graph.applyTurn(3, [{ op: 'SUPERSEDE', oldId: 'n_0001', newId: 'n_0002' }], TS);
  assert.equal(again.ok, false);
});

test('MERGE unions rings and redirects edges', async () => {
  const graph = new ThoughtGraph('s1', new MemoryStorage());
  await graph.applyTurn(1, [addClaim('A'), addClaim('B'), addClaim('C')], TS);
  await graph.applyTurn(2, [
    { op: 'REINFORCE', nodeId: 'n_0002', turn: 2 },
    { op: 'ADD_EDGE', edge: { from: 'n_0003', to: 'n_0002', kind: 'related', bornTurn: 2 } },
  ], TS);
  const result = await graph.applyTurn(3, [{ op: 'MERGE', fromId: 'n_0002', intoId: 'n_0001' }], TS);
  assert.equal(result.ok, true);
  const map = graph.getMap();
  const from = map.nodes.find((n) => n.id === 'n_0002');
  const into = map.nodes.find((n) => n.id === 'n_0001');
  assert.equal(from?.status, 'merged');
  assert.equal(from?.mergedInto, 'n_0001');
  assert.deepEqual(into?.rings, [1, 2]);
  assert.ok(map.edges.some((e) => e.from === 'n_0003' && e.to === 'n_0001' && e.kind === 'related'));
  assert.ok(!map.edges.some((e) => e.from === 'n_0002' || e.to === 'n_0002'));
  const reject = await graph.applyTurn(4, [{ op: 'MERGE', fromId: 'n_0002', intoId: 'n_0003' }], TS);
  assert.equal(reject.ok, false);
});

test('DELETE removes node and touching edges', async () => {
  const graph = new ThoughtGraph('s1', new MemoryStorage());
  await graph.applyTurn(2, [addClaim('B')], TS);
  await graph.applyTurn(3, [addClaim('C'), { op: 'ADD_EDGE', edge: { from: 'n_0001', to: 'n_0002', kind: 'related', bornTurn: 3 } }], TS);
  const result = await graph.applyTurn(4, [{ op: 'DELETE', nodeId: 'n_0001' }], TS);
  assert.equal(result.ok, true);
  const map = graph.getMap();
  assert.ok(!map.nodes.some((n) => n.id === 'n_0001'));
  assert.ok(!map.edges.some((e) => e.from === 'n_0001' || e.to === 'n_0001'));
});

test('reload restores state, processed turns, and id counter', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [addClaim('观点A')], TS);
  await graph.applyTurn(2, [{ op: 'REINFORCE', nodeId: 'n_0001', turn: 2 }], TS);

  const reloaded = await ThoughtGraph.load('s1', storage);
  assert.equal(reloaded.isProcessed(1), true);
  assert.equal(reloaded.isProcessed(2), true);
  const dup = await reloaded.applyTurn(1, [addClaim('重复')], TS);
  assert.equal(dup.duplicate, true);
  const next = await reloaded.applyTurn(3, [addClaim('观点B')], TS);
  assert.equal(next.ok, true);
  const ids = reloaded.getMap().nodes.map((n) => n.id);
  assert.ok(ids.includes('n_0002'));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(reloaded.getMap().nodes[0].rings, [1, 2]);
});

test('skeleton only contains active nodes', async () => {
  const graph = new ThoughtGraph('s1', new MemoryStorage());
  await graph.applyTurn(1, [addClaim('A'), addClaim('B')], TS);
  await graph.applyTurn(2, [{ op: 'SUPERSEDE', oldId: 'n_0001', newId: 'n_0002' }], TS);
  const skeleton = graph.skeleton();
  assert.equal(skeleton.length, 1);
  assert.equal(skeleton[0].id, 'n_0002');
});