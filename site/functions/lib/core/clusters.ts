import type { GraphMap } from './types.ts';

export interface ClusterGroup {
  key: string;
  index: number;
  nodeIds: string[];
}

export interface ClusterSnapshot {
  clusters: ClusterGroup[];
  isolated: string[];
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function clusterKey(nodeIds: string[]): string {
  return `k${fnv1a([...nodeIds].sort().join(','))}`;
}

export function computeClusters(map: GraphMap): ClusterSnapshot {
  const parent = new Map<string, string>();
  for (const node of map.nodes) parent.set(node.id, node.id);

  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      const next = parent.get(root) ?? root;
      parent.set(root, parent.get(next) ?? next);
      root = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const edge of map.edges) {
    if (edge.kind !== 'related') continue;
    if (!parent.has(edge.from) || !parent.has(edge.to)) continue;
    union(edge.from, edge.to);
  }

  const buckets = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const list = buckets.get(root) ?? [];
    list.push(id);
    buckets.set(root, list);
  }

  const components = [...buckets.values()]
    .filter((ids) => ids.length >= 2)
    .map((ids) => ids.sort())
    .sort((a, b) => (b.length !== a.length ? b.length - a.length : a[0].localeCompare(b[0])));

  const isolated = [...parent.keys()].filter((id) => find(id) === id && buckets.get(id)?.length === 1).sort();

  return {
    clusters: components.map((nodeIds, idx) => ({
      key: clusterKey(nodeIds),
      index: idx + 1,
      nodeIds,
    })),
    isolated,
  };
}