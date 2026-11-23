import type { GraphMap, ThoughtNode, ThoughtEdge } from '@thought-atlas/core';

export interface NodeVisual {
  fill: string;
  stroke: string;
  strokeWidth: number;
  shape: 'circle' | 'diamond';
  strike: boolean;
  dim: boolean;
}

export type EdgeKind = ThoughtEdge['kind'];

export interface EdgeVisual {
  stroke: string;
  width: number;
  dash: number[];
}

const USER_FILL = '#4c8dff';
const USER_STROKE = '#9cc0ff';
const AI_FILL = '#586079';
const AI_STROKE = '#7b849c';
const SHIFT_FILL = '#f0a24a';
const SHIFT_STROKE = '#ffd08a';
const MUTED_FILL = '#454c5e';
const MUTED_STROKE = '#5f677b';

const BASE_RADIUS = 9;

export function nodeRadius(node: ThoughtNode): number {
  const ringBoost = 1 + Math.min(Math.max(node.rings.length - 1, 0), 5) * 0.07;
  const typeBase = node.type === 'ai-voice' ? 0.72 : node.type === 'shift' ? 1.18 : 1;
  return BASE_RADIUS * typeBase * ringBoost;
}

export function nodeVisual(node: ThoughtNode): NodeVisual {
  if (node.type === 'shift') {
    const muted = node.status !== 'active';
    return {
      fill: muted ? MUTED_FILL : SHIFT_FILL,
      stroke: muted ? MUTED_STROKE : SHIFT_STROKE,
      strokeWidth: 2.5,
      shape: 'diamond',
      strike: muted,
      dim: false,
    };
  }
  if (node.type === 'ai-voice') {
    return {
      fill: node.status === 'active' ? AI_FILL : MUTED_FILL,
      stroke: AI_STROKE,
      strokeWidth: 1.2,
      shape: 'circle',
      strike: node.status !== 'active',
      dim: true,
    };
  }
  const inactive = node.status !== 'active';
  return {
    fill: inactive ? MUTED_FILL : USER_FILL,
    stroke: inactive ? MUTED_STROKE : USER_STROKE,
    strokeWidth: 1.6,
    shape: 'circle',
    strike: inactive,
    dim: false,
  };
}

export function edgeVisual(kind: EdgeKind): EdgeVisual {
  if (kind === 'influence') return { stroke: '#ffb45e', width: 1.8, dash: [6, 4] };
  if (kind === 'supersede') return { stroke: '#8b93a7', width: 1.3, dash: [3, 5] };
  return { stroke: '#39415a', width: 1.1, dash: [] };
}

export function computeNeighborhood(map: GraphMap, id: string): Set<string> {
  const set = new Set<string>([id]);
  for (const edge of map.edges) {
    if (edge.from === id) set.add(edge.to);
    if (edge.to === id) set.add(edge.from);
  }
  return set;
}

export interface MapDiff {
  added: string[];
  removed: string[];
  changed: string[];
  edgesChanged: boolean;
}

export function diffMap(prev: GraphMap | null, next: GraphMap): MapDiff {
  const prevNodes = new Map((prev?.nodes ?? []).map((n) => [n.id, n]));
  const nextIds = new Set(next.nodes.map((n) => n.id));
  const added: string[] = [];
  const changed: string[] = [];
  for (const node of next.nodes) {
    const old = prevNodes.get(node.id);
    if (!old) {
      added.push(node.id);
    } else if (
      old.label !== node.label ||
      old.summary !== node.summary ||
      old.status !== node.status ||
      old.rings.length !== node.rings.length
    ) {
      changed.push(node.id);
    }
  }
  const removed = [...prevNodes.keys()].filter((id) => !nextIds.has(id));
  const sig = (map: GraphMap | null): string =>
    (map?.edges ?? []).map((e) => `${e.from}>${e.to}:${e.kind}`).join('|');
  return { added, removed, changed, edgesChanged: sig(prev) !== sig(next) };
}

export function mapSignature(map: GraphMap): string {
  const nodes = map.nodes
    .map((n) => `${n.id}:${n.type}:${n.status}:${n.rings.length}:${n.label}`)
    .join('|');
  const edges = map.edges.map((e) => `${e.from}>${e.to}:${e.kind}`).join('|');
  return `${map.nodes.length}#${nodes}##${edges}`;
}

export function nodeTypeLabel(type: ThoughtNode['type']): string {
  switch (type) {
    case 'claim':
      return '论点';
    case 'question':
      return '问题';
    case 'fact':
      return '事实';
    case 'ai-voice':
      return 'AI 观点';
    case 'shift':
      return '认知转变';
  }
}