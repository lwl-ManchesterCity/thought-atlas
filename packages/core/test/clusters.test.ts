import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterKey, computeClusters } from '../src/index.ts';
import type { GraphMap, ThoughtEdge, ThoughtNode } from '../src/index.ts';

function node(id: string, label = id): ThoughtNode {
  return {
    id,
    type: 'claim',
    owner: 'user',
    label,
    summary: label,
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

function map(nodes: ThoughtNode[], edges: ThoughtEdge[]): GraphMap {
  return { sessionId: 's', nodes, edges, lastTurn: 1 };
}

test('related edges form sorted components; influence alone does not join clusters', () => {
  const snapshot = computeClusters(
    map(
      [node('n_0001'), node('n_0002'), node('n_0003'), node('n_0004'), node('n_0005')],
      [
        edge('n_0001', 'n_0002'),
        edge('n_0002', 'n_0003'),
        edge('n_0004', 'n_0001', 'influence'),
        edge('n_0004', 'n_0005', 'supersede'),
      ],
    ),
  );
  assert.equal(snapshot.clusters.length, 1);
  assert.deepEqual(snapshot.clusters[0].nodeIds, ['n_0001', 'n_0002', 'n_0003']);
  assert.deepEqual(snapshot.isolated, ['n_0004', 'n_0005']);
  assert.equal(snapshot.clusters[0].index, 1);
});

test('clusters are ordered by size then first id and keys are stable', () => {
  const snapshot = computeClusters(
    map(
      [node('a'), node('b'), node('c'), node('d'), node('e')],
      [edge('a', 'b'), edge('c', 'd'), edge('d', 'e')],
    ),
  );
  assert.equal(snapshot.clusters.length, 2);
  assert.deepEqual(snapshot.clusters[0].nodeIds, ['c', 'd', 'e']);
  assert.deepEqual(snapshot.clusters[1].nodeIds, ['a', 'b']);
  assert.equal(clusterKey(['b', 'a']), clusterKey(['a', 'b']));
  assert.notEqual(clusterKey(['a', 'b']), clusterKey(['a', 'c']));
});

test('empty and fully isolated maps yield no clusters', () => {
  assert.deepEqual(computeClusters(map([], [])), { clusters: [], isolated: [] });
  const snapshot = computeClusters(map([node('x'), node('y')], []));
  assert.equal(snapshot.clusters.length, 0);
  assert.deepEqual(snapshot.isolated, ['x', 'y']);
});