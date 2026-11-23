import type {
  EventRecord,
  GraphMap,
  MapOp,
  SkeletonNode,
  ShiftFields,
  ThoughtEdge,
  ThoughtNode,
} from './types.ts';
import { LABEL_MAX, SUMMARY_MAX } from './types.ts';
import type { Storage, Transport } from './ports.ts';
import { validateOpsShape } from './schema.ts';

export interface ApplyResult {
  ok: boolean;
  duplicate?: boolean;
  reason?: string;
  ops?: MapOp[];
}

interface SimState {
  nodes: Map<string, ThoughtNode>;
  edges: ThoughtEdge[];
  nextId: number;
}

class OpError extends Error {}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

function allocId(sim: SimState): string {
  let id: string;
  do {
    id = `n_${String(sim.nextId).padStart(4, '0')}`;
    sim.nextId++;
  } while (sim.nodes.has(id));
  return id;
}

function resolveRef(ref: string, currentNewId: string | null, lastCreated: string | null): string {
  if (ref === '@new') {
    if (!currentNewId) throw new OpError('@new is only valid inside ADD_NODE.edges');
    return currentNewId;
  }
  if (ref === '@prev') {
    if (!lastCreated) throw new OpError('@prev has no preceding created node in this batch');
    return lastCreated;
  }
  return ref;
}

function requireNode(sim: SimState, id: string): ThoughtNode {
  const node = sim.nodes.get(id);
  if (!node) throw new OpError(`dangling node reference: ${id}`);
  return node;
}

function requireActive(sim: SimState, id: string): ThoughtNode {
  const node = requireNode(sim, id);
  if (node.status !== 'active') throw new OpError(`node ${id} is not active (${node.status})`);
  return node;
}

function addEdge(sim: SimState, edge: ThoughtEdge): void {
  if (edge.from === edge.to) throw new OpError('self-loop edge not allowed');
  const from = requireNode(sim, edge.from);
  const to = requireNode(sim, edge.to);
  if (from.status === 'merged' || to.status === 'merged') {
    throw new OpError(`edge touches merged node: ${edge.from} -> ${edge.to}`);
  }
  if (edge.kind === 'influence' && (from.type !== 'ai-voice' || to.type !== 'shift')) {
    throw new OpError('influence edge must go from ai-voice to shift');
  }
  const exists = sim.edges.some(
    (e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind,
  );
  if (!exists) sim.edges.push(edge);
}

function resolveShift(
  shift: ShiftFields,
  lastCreated: string | null,
): ShiftFields {
  return {
    ...shift,
    fromNodeId: shift.fromNodeId ? resolveRef(shift.fromNodeId, null, lastCreated) : null,
    triggerNodeId: shift.triggerNodeId ? resolveRef(shift.triggerNodeId, null, lastCreated) : null,
    retro: shift.retro ?? false,
  };
}

function buildNode(id: string, base: Omit<ThoughtNode, 'id'>): ThoughtNode {
  return { id, ...base };
}

function applyOp(
  sim: SimState,
  op: MapOp,
  turn: number,
  lastCreated: string | null,
): { resolved: MapOp; created: string | null } {
  switch (op.op) {
    case 'ADD_NODE': {
      const id = allocId(sim);
      const n = op.node;
      const shift = n.shift ? resolveShift(n.shift, lastCreated) : undefined;
      if (shift?.fromNodeId) {
        const from = requireActive(sim, shift.fromNodeId);
        if (from.type === 'ai-voice') throw new OpError('shift.fromNodeId must not reference an ai-voice node');
      }
      if (shift?.triggerNodeId) {
        const trigger = requireActive(sim, shift.triggerNodeId);
        if (trigger.type !== 'ai-voice') throw new OpError('shift.triggerNodeId must reference an ai-voice node');
      }
      const node = buildNode(id, {
        type: n.type,
        owner: n.type === 'ai-voice' ? 'ai' : (n.owner ?? 'user'),
        label: truncate(n.label, LABEL_MAX),
        summary: truncate(n.summary, SUMMARY_MAX),
        bornTurn: turn,
        lastTurn: turn,
        rings: [turn],
        status: 'active',
        supersededBy: null,
        mergedInto: null,
        anchorTurns: n.anchorTurns?.length ? [...new Set(n.anchorTurns)] : [turn],
        clusterId: null,
        manual: false,
        ...(shift ? { shift } : {}),
      });
      sim.nodes.set(id, node);
      const edges: ThoughtEdge[] = [];
      for (const e of op.edges ?? []) {
        const resolvedEdge: ThoughtEdge = {
          from: resolveRef(e.from, id, lastCreated),
          to: resolveRef(e.to, id, lastCreated),
          kind: e.kind,
          bornTurn: e.bornTurn,
        };
        addEdge(sim, resolvedEdge);
        edges.push(resolvedEdge);
      }
      return { resolved: { op: 'ADD_NODE', node, edges }, created: id };
    }
    case 'REINFORCE': {
      const id = resolveRef(op.nodeId, null, lastCreated);
      const node = requireActive(sim, id);
      if (!node.rings.includes(op.turn)) node.rings.push(op.turn);
      if (!node.anchorTurns.includes(op.turn)) node.anchorTurns.push(op.turn);
      node.lastTurn = Math.max(node.lastTurn, op.turn);
      return { resolved: { op: 'REINFORCE', nodeId: id, turn: op.turn }, created: null };
    }
    case 'UPDATE_NODE': {
      const id = resolveRef(op.nodeId, null, lastCreated);
      const node = requireNode(sim, id);
      if (node.status === 'merged') throw new OpError(`cannot update merged node ${id}`);
      if (op.patch.label !== undefined) node.label = truncate(op.patch.label, LABEL_MAX);
      if (op.patch.summary !== undefined) node.summary = truncate(op.patch.summary, SUMMARY_MAX);
      return {
        resolved: { op: 'UPDATE_NODE', nodeId: id, patch: { ...op.patch } },
        created: null,
      };
    }
    case 'MARK_SHIFT': {
      const shift = resolveShift(op.shift, lastCreated);
      if (shift.fromNodeId) {
        const from = requireActive(sim, shift.fromNodeId);
        if (from.type === 'ai-voice') throw new OpError('shift.fromNodeId must not reference an ai-voice node');
      }
      let trigger: ThoughtNode | null = null;
      if (shift.triggerNodeId) {
        trigger = requireActive(sim, shift.triggerNodeId);
        if (trigger.type !== 'ai-voice') throw new OpError('shift.triggerNodeId must reference an ai-voice node');
      }
      let shiftId: string;
      let created: string | null = null;
      if (op.nodeId !== null) {
        const id = resolveRef(op.nodeId, null, lastCreated);
        const node = requireActive(sim, id);
        node.type = 'shift';
        node.shift = shift;
        if (!node.rings.includes(turn)) node.rings.push(turn);
        if (!node.anchorTurns.includes(turn)) node.anchorTurns.push(turn);
        node.lastTurn = Math.max(node.lastTurn, turn);
        shiftId = id;
      } else {
        shiftId = allocId(sim);
        created = shiftId;
        sim.nodes.set(shiftId, buildNode(shiftId, {
          type: 'shift',
          owner: 'user',
          label: truncate(shift.toSummary, LABEL_MAX),
          summary: truncate(shift.toSummary, SUMMARY_MAX),
          bornTurn: turn,
          lastTurn: turn,
          rings: [turn],
          status: 'active',
          supersededBy: null,
          mergedInto: null,
          anchorTurns: [turn],
          clusterId: null,
          manual: false,
          shift,
        }));
      }
      if (trigger) {
        addEdge(sim, { from: trigger.id, to: shiftId, kind: 'influence', bornTurn: shift.triggerTurn ?? turn });
      }
      if (shift.fromNodeId) {
        const old = requireNode(sim, shift.fromNodeId);
        old.status = 'superseded';
        old.supersededBy = shiftId;
        addEdge(sim, { from: old.id, to: shiftId, kind: 'supersede', bornTurn: turn });
      }
      return { resolved: { op: 'MARK_SHIFT', nodeId: shiftId, shift }, created };
    }
    case 'SUPERSEDE': {
      const oldId = resolveRef(op.oldId, null, lastCreated);
      const newId = resolveRef(op.newId, null, lastCreated);
      const old = requireActive(sim, oldId);
      requireActive(sim, newId);
      old.status = 'superseded';
      old.supersededBy = newId;
      addEdge(sim, { from: oldId, to: newId, kind: 'supersede', bornTurn: turn });
      return { resolved: { op: 'SUPERSEDE', oldId, newId }, created: null };
    }
    case 'MERGE': {
      const fromId = resolveRef(op.fromId, null, lastCreated);
      const intoId = resolveRef(op.intoId, null, lastCreated);
      const from = requireActive(sim, fromId);
      const into = requireActive(sim, intoId);
      from.status = 'merged';
      from.mergedInto = intoId;
      into.rings = [...new Set([...into.rings, ...from.rings])].sort((a, b) => a - b);
      into.anchorTurns = [...new Set([...into.anchorTurns, ...from.anchorTurns])].sort((a, b) => a - b);
      into.lastTurn = Math.max(into.lastTurn, from.lastTurn);
      const redirected: ThoughtEdge[] = [];
      for (const e of sim.edges) {
        const fromEnd = e.from === fromId ? intoId : e.from;
        const toEnd = e.to === fromId ? intoId : e.to;
        if (fromEnd === toEnd) continue;
        if (!redirected.some((r) => r.from === fromEnd && r.to === toEnd && r.kind === e.kind)) {
          redirected.push({ ...e, from: fromEnd, to: toEnd });
        }
      }
      sim.edges = redirected;
      return { resolved: { op: 'MERGE', fromId, intoId }, created: null };
    }
    case 'ADD_EDGE': {
      const edge: ThoughtEdge = {
        from: resolveRef(op.edge.from, null, lastCreated),
        to: resolveRef(op.edge.to, null, lastCreated),
        kind: op.edge.kind,
        bornTurn: op.edge.bornTurn,
      };
      addEdge(sim, edge);
      return { resolved: { op: 'ADD_EDGE', edge }, created: null };
    }
    case 'DELETE': {
      const id = resolveRef(op.nodeId, null, lastCreated);
      requireNode(sim, id);
      sim.nodes.delete(id);
      sim.edges = sim.edges.filter((e) => e.from !== id && e.to !== id);
      return { resolved: { op: 'DELETE', nodeId: id }, created: null };
    }
    case 'SKIP':
      return { resolved: { op: 'SKIP' }, created: null };
  }
}

export class ThoughtGraph {
  private nodes = new Map<string, ThoughtNode>();
  private edges: ThoughtEdge[] = [];
  private nextId = 1;
  private processed = new Set<number>();
  private lastTurn = 0;

  private sessionId: string;
  private storage: Storage;
  private transport?: Transport;

  constructor(sessionId: string, storage: Storage, transport?: Transport) {
    this.sessionId = sessionId;
    this.storage = storage;
    this.transport = transport;
  }

  static async load(
    sessionId: string,
    storage: Storage,
    transport?: Transport,
  ): Promise<ThoughtGraph> {
    const graph = new ThoughtGraph(sessionId, storage, transport);
    const map = await storage.loadMap();
    if (map) {
      for (const node of map.nodes) {
        graph.nodes.set(node.id, node);
        const num = Number(node.id.slice(2));
        if (Number.isInteger(num)) graph.nextId = Math.max(graph.nextId, num + 1);
      }
      graph.edges = map.edges;
      graph.lastTurn = map.lastTurn;
    }
    const events = await storage.loadEvents();
    for (const event of events) graph.processed.add(event.turnIndex);
    return graph;
  }

  isProcessed(turnIndex: number): boolean {
    return this.processed.has(turnIndex);
  }

  getMap(): GraphMap {
    return {
      sessionId: this.sessionId,
      nodes: [...this.nodes.values()],
      edges: [...this.edges],
      lastTurn: this.lastTurn,
    };
  }

  skeleton(): SkeletonNode[] {
    return [...this.nodes.values()]
      .filter((n) => n.status === 'active')
      .map((n) => ({ id: n.id, type: n.type, label: n.label, summary: n.summary, lastTurn: n.lastTurn }));
  }

  async applyTurn(turnIndex: number, ops: MapOp[], timestamp: string): Promise<ApplyResult> {
    if (!Number.isInteger(turnIndex) || turnIndex < 1) {
      return { ok: false, reason: 'turnIndex must be a positive integer' };
    }
    if (this.processed.has(turnIndex)) {
      return { ok: true, duplicate: true };
    }
    const shape = validateOpsShape({ ops });
    if (!shape.ok) {
      await this.storage.appendFailure({ turnIndex, timestamp, reason: `shape: ${shape.error}` });
      return { ok: false, reason: shape.error };
    }

    const sim: SimState = structuredClone({
      nodes: this.nodes,
      edges: this.edges,
      nextId: this.nextId,
    });
    const resolved: MapOp[] = [];
    let lastCreated: string | null = null;
    try {
      for (const op of shape.ops) {
        const result = applyOp(sim, op, turnIndex, lastCreated);
        resolved.push(result.resolved);
        if (result.created) lastCreated = result.created;
      }
    } catch (err) {
      const reason = err instanceof OpError ? err.message : String(err);
      await this.storage.appendFailure({ turnIndex, timestamp, reason: `apply: ${reason}` });
      return { ok: false, reason };
    }

    this.nodes = sim.nodes;
    this.edges = sim.edges;
    this.nextId = sim.nextId;
    this.processed.add(turnIndex);
    this.lastTurn = Math.max(this.lastTurn, turnIndex);

    const record: EventRecord = { turnIndex, timestamp, ops: resolved };
    await this.storage.appendEvent(record);
    const map = this.getMap();
    await this.storage.saveMap(map);
    this.transport?.publish({ sessionId: this.sessionId, turnIndex, map });
    return { ok: true, ops: resolved };
  }
}