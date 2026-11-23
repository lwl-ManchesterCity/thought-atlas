import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphMap, ThoughtNode, ThoughtEdge } from '@thought-atlas/core';
import {
  computeNeighborhood,
  convexHull,
  diffMap,
  edgeVisual,
  mapSignature,
  nodeRadius,
  nodeTypeLabel,
  nodeVisual,
  tierForZoom,
  FAR_ZOOM,
  NEAR_ZOOM,
} from '../src/graph-model.ts';

function node(id: string, patch: Partial<ThoughtNode> = {}): ThoughtNode {
  return {
    id,
    type: 'claim',
    owner: 'user',
    label: id,
    summary: `${id} summary`,
    bornTurn: 1,
    lastTurn: 1,
    rings: [1],
    status: 'active',
    supersededBy: null,
    mergedInto: null,
    anchorTurns: [1],
    clusterId: null,
    manual: false,
    ...patch,
  };
}

function edge(from: string, to: string, kind: ThoughtEdge['kind'] = 'related'): ThoughtEdge {
  return { from, to, kind, bornTurn: 1 };
}

function map(nodes: ThoughtNode[], edges: ThoughtEdge[] = []): GraphMap {
  return { sessionId: 's1', nodes, edges, lastTurn: 1 };
}

test('computeNeighborhood 只取自身与一跳邻居', () => {
  const m = map([node('a'), node('b'), node('c'), node('d')], [edge('a', 'b'), edge('b', 'c')]);
  const focus = computeNeighborhood(m, 'a');
  assert.deepEqual([...focus].sort(), ['a', 'b']);
  assert.equal(focus.has('c'), false);
});

test('nodeVisual: AI 观点小而淡，shift 为菱形暖色，superseded 置灰划线', () => {
  const ai = nodeVisual(node('ai', { type: 'ai-voice', owner: 'ai' }));
  const shift = nodeVisual(node('sh', { type: 'shift' }));
  const dead = nodeVisual(node('old', { status: 'superseded', supersededBy: 'x' }));
  assert.equal(ai.dim, true);
  assert.equal(shift.shape, 'diamond');
  assert.equal(shift.fill, '#f0a24a');
  assert.equal(dead.strike, true);
  assert.notEqual(dead.fill, '#4c8dff');
  assert.equal(nodeVisual(node('user')).dim, false);
});

test('nodeRadius: 年轮越多半径越大，AI 观点小于用户节点', () => {
  const one = nodeRadius(node('a'));
  const four = nodeRadius(node('b', { rings: [1, 2, 3, 4] }));
  const ai = nodeRadius(node('c', { type: 'ai-voice' }));
  assert.ok(four > one);
  assert.ok(ai < one);
});

test('edgeVisual: influence 高亮虚线，related 细灰实线，supersede 灰虚线', () => {
  const influence = edgeVisual('influence');
  const related = edgeVisual('related');
  const supersede = edgeVisual('supersede');
  assert.ok(influence.dash.length > 0);
  assert.ok(influence.width > related.width);
  assert.equal(related.dash.length, 0);
  assert.ok(supersede.dash.length > 0);
});

test('diffMap 识别新增 / 移除 / 变更 / 边变化', () => {
  const before = map([node('a'), node('b')], [edge('a', 'b')]);
  const after = map(
    [node('a', { rings: [1, 2] }), node('c')],
    [edge('a', 'c', 'influence')],
  );
  const diff = diffMap(before, after);
  assert.deepEqual(diff.added, ['c']);
  assert.deepEqual(diff.removed, ['b']);
  assert.deepEqual(diff.changed, ['a']);
  assert.equal(diff.edgesChanged, true);
});

test('mapSignature 对 lastTurn 变化不敏感，对节点语义变化敏感', () => {
  const a = map([node('a')], []);
  const sameTurn = { ...map([node('a')], []), lastTurn: 9 };
  const changed = map([node('a', { label: '新标签' })], []);
  assert.equal(mapSignature(a), mapSignature(sameTurn));
  assert.notEqual(mapSignature(a), mapSignature(changed));
});

test('nodeTypeLabel 覆盖全部类型', () => {
  assert.equal(nodeTypeLabel('claim'), '论点');
  assert.equal(nodeTypeLabel('question'), '问题');
  assert.equal(nodeTypeLabel('fact'), '事实');
  assert.equal(nodeTypeLabel('ai-voice'), 'AI 观点');
  assert.equal(nodeTypeLabel('shift'), '认知转变');
});

test('tierForZoom: 远/中/近三档按阈值切换', () => {
  assert.equal(tierForZoom(0.3), 'far');
  assert.equal(tierForZoom(FAR_ZOOM - 0.01), 'far');
  assert.equal(tierForZoom(FAR_ZOOM), 'mid');
  assert.equal(tierForZoom(NEAR_ZOOM - 0.01), 'mid');
  assert.equal(tierForZoom(NEAR_ZOOM), 'near');
  assert.equal(tierForZoom(2.4), 'near');
});

test('convexHull: 返回逆时针凸包并剔除内部点，退化输入安全', () => {
  const hull = convexHull([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 5, y: 5 },
    { x: 2, y: 2 },
  ]);
  assert.equal(hull.length, 4);
  assert.deepEqual(
    hull.map((p) => `${p.x},${p.y}`).sort(),
    ['0,0', '0,10', '10,0', '10,10'],
  );
  assert.deepEqual(convexHull([]), []);
  assert.equal(convexHull([{ x: 1, y: 2 }]).length, 1);
  assert.equal(convexHull([{ x: 0, y: 0 }, { x: 1, y: 1 }]).length, 2);
  const collinear = convexHull([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 2 },
  ]);
  assert.equal(collinear.length, 2);
});