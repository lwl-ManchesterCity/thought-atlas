import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANUAL_TURN_BASE,
  ThoughtGraph,
  createReplayState,
  foldEvents,
  replayApply,
  replayMap,
} from '../src/index.ts';
import type { GraphMap, MapOp } from '../src/index.ts';
import { MemoryStorage, TS } from './helpers.ts';

function addClaim(label: string): MapOp {
  return { op: 'ADD_NODE', node: { type: 'claim', label, summary: label } };
}

function signature(map: GraphMap): string {
  const nodes = map.nodes
    .map((n) => `${n.id}:${n.type}:${n.status}:${n.manual}`)
    .sort()
    .join('|');
  const edges = map.edges
    .map((e) => `${e.from}>${e.to}:${e.kind}`)
    .sort()
    .join('|');
  return `${nodes}##${edges}`;
}

test('foldEvents folds resolved events by turn and matches live map', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [addClaim('浮点误差是JS的bug')], TS);
  await graph.applyTurn(
    2,
    [
      { op: 'ADD_NODE', node: { type: 'ai-voice', label: 'IEEE754精度取舍', summary: 'AI解释IEEE754' } },
      {
        op: 'MARK_SHIFT',
        nodeId: null,
        shift: { fromNodeId: 'n_0001', toSummary: '浮点误差是精度取舍', triggerNodeId: 'n_0002' },
      },
    ],
    TS,
  );
  await graph.applyTurn(3, [{ op: 'DELETE', nodeId: 'n_0002' }], TS);

  const at1 = foldEvents('s1', storage.events, 1);
  assert.equal(at1.nodes.length, 1);
  assert.equal(at1.nodes[0].id, 'n_0001');
  assert.equal(at1.nodes[0].status, 'active');

  const at2 = foldEvents('s1', storage.events, 2);
  assert.equal(at2.nodes.length, 3);
  const old = at2.nodes.find((n) => n.id === 'n_0001');
  const shift = at2.nodes.find((n) => n.id === 'n_0003');
  assert.equal(old?.status, 'superseded');
  assert.equal(shift?.type, 'shift');
  assert.equal(shift?.shift?.fromNodeId, 'n_0001');
  assert.ok(at2.edges.some((e) => e.from === 'n_0002' && e.to === 'n_0003' && e.kind === 'influence'));

  const full = foldEvents('s1', storage.events);
  assert.equal(full.nodes.length, 2);
  assert.equal(signature(full), signature(graph.getMap()));
  assert.equal(full.lastTurn, 3);
});

test('incremental replayApply cursor equals one-shot fold', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [addClaim('A')], TS);
  await graph.applyTurn(2, [addClaim('B')], TS);
  await graph.applyTurn(3, [{ op: 'REINFORCE', nodeId: 'n_0001', turn: 3 }], TS);

  const state = createReplayState('s1');
  replayApply(state, storage.events[0]);
  replayApply(state, storage.events[1]);
  const two = replayMap(state);
  assert.equal(two.nodes.length, 2);
  assert.equal(two.lastTurn, 2);

  replayApply(state, storage.events[2]);
  assert.equal(signature(replayMap(state)), signature(foldEvents('s1', storage.events)));
});

test('manual mark-shift appends isolated event, sets manual flag, keeps lastTurn', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [addClaim('A')], TS);
  await graph.applyTurn(
    2,
    [{ op: 'ADD_NODE', node: { type: 'ai-voice', label: 'AI观点', summary: 'AI观点' } }],
    TS,
  );

  const result = await graph.applyManual(
    [{ op: 'MARK_SHIFT', nodeId: 'n_0001', shift: { toSummary: '手动标记后的转变' }, manual: true }],
    TS,
  );
  assert.equal(result.ok, true);
  assert.equal(storage.events.at(-1)?.turnIndex, MANUAL_TURN_BASE);

  const node = graph.getMap().nodes.find((n) => n.id === 'n_0001');
  assert.equal(node?.type, 'shift');
  assert.equal(node?.manual, true);
  assert.equal(graph.getMap().lastTurn, 2);

  const folded = foldEvents('s1', storage.events);
  assert.equal(folded.nodes.find((n) => n.id === 'n_0001')?.type, 'shift');
  const beforeManual = foldEvents('s1', storage.events, 2);
  assert.equal(beforeManual.nodes.find((n) => n.id === 'n_0001')?.type, 'claim');
});

test('manual delete is soft in event log and replay reflects disappearance', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [addClaim('A'), addClaim('B')], TS);

  const result = await graph.applyManual([{ op: 'DELETE', nodeId: 'n_0002' }], TS);
  assert.equal(result.ok, true);
  assert.equal(graph.getMap().nodes.length, 1);
  assert.equal(foldEvents('s1', storage.events).nodes.length, 1);
  assert.equal(foldEvents('s1', storage.events, 1).nodes.length, 2);
  assert.equal(storage.events.at(-1)?.ops[0].op, 'DELETE');
});

test('manual mark-shift on ai-voice is rejected atomically without event', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(
    1,
    [{ op: 'ADD_NODE', node: { type: 'ai-voice', label: 'AI观点', summary: 'AI观点' } }],
    TS,
  );
  const eventsBefore = storage.events.length;
  const result = await graph.applyManual(
    [{ op: 'MARK_SHIFT', nodeId: 'n_0001', shift: { toSummary: '不合法转变' }, manual: true }],
    TS,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /ai-voice/);
  assert.equal(storage.events.length, eventsBefore);
  assert.equal(graph.getMap().nodes[0].type, 'ai-voice');
});

test('manual batch stays atomic when a later op fails', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [addClaim('A')], TS);
  const before = JSON.stringify(graph.getMap());
  const eventsBefore = storage.events.length;

  const result = await graph.applyManual(
    [addClaim('B'), { op: 'DELETE', nodeId: 'n_9999' }],
    TS,
  );
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(graph.getMap()), before);
  assert.equal(storage.events.length, eventsBefore);
});

test('manual turn indices increment beyond loaded manual events', async () => {
  const storage = new MemoryStorage();
  const graph = new ThoughtGraph('s1', storage);
  await graph.applyTurn(1, [addClaim('A'), addClaim('B')], TS);
  await graph.applyManual([{ op: 'DELETE', nodeId: 'n_0001' }], TS);
  await graph.applyManual([{ op: 'DELETE', nodeId: 'n_0002' }], TS);
  assert.deepEqual(
    storage.events.filter((e) => e.turnIndex >= MANUAL_TURN_BASE).map((e) => e.turnIndex),
    [MANUAL_TURN_BASE, MANUAL_TURN_BASE + 1],
  );

  const reloaded = await ThoughtGraph.load('s1', storage);
  await reloaded.applyManual([{ op: 'SKIP' }], TS);
  assert.equal(storage.events.at(-1)?.turnIndex, MANUAL_TURN_BASE + 2);
});