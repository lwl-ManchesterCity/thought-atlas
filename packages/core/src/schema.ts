import type { MapOp } from './types.ts';
import { MAX_OPS_PER_TURN } from './types.ts';

export type ShapeResult =
  | { ok: true; ops: MapOp[] }
  | { ok: false; error: string };

const NODE_TYPES = new Set(['claim', 'question', 'shift', 'fact', 'ai-voice']);
const EDGE_KINDS = new Set(['influence', 'related', 'supersede']);
const OP_KINDS = new Set([
  'ADD_NODE', 'REINFORCE', 'UPDATE_NODE', 'MARK_SHIFT',
  'SUPERSEDE', 'MERGE', 'ADD_EDGE', 'DELETE', 'SKIP',
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isTurn(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}
function isRefOrNull(v: unknown): boolean {
  return v === null || v === undefined || isStr(v);
}

function checkEdge(v: unknown): string | null {
  if (!isObj(v)) return 'edge must be an object';
  if (!isStr(v.from) || !isStr(v.to)) return 'edge.from/to must be non-empty strings';
  if (!EDGE_KINDS.has(v.kind as string)) return `invalid edge kind: ${String(v.kind)}`;
  if (!isTurn(v.bornTurn)) return 'edge.bornTurn must be a positive integer';
  return null;
}

function checkShift(v: unknown): string | null {
  if (!isObj(v)) return 'shift must be an object';
  if (!isStr(v.toSummary)) return 'shift.toSummary must be a non-empty string';
  if (!isRefOrNull(v.fromNodeId)) return 'shift.fromNodeId must be string or null';
  if (!isRefOrNull(v.triggerNodeId)) return 'shift.triggerNodeId must be string or null';
  if (v.triggerTurn !== undefined && !isTurn(v.triggerTurn)) return 'shift.triggerTurn must be a positive integer';
  if (v.retro !== undefined && typeof v.retro !== 'boolean') return 'shift.retro must be boolean';
  return null;
}

function checkOp(op: unknown): string | null {
  if (!isObj(op)) return 'op must be an object';
  if (!OP_KINDS.has(op.op as string)) return `unknown op: ${String(op.op)}`;
  switch (op.op) {
    case 'ADD_NODE': {
      const n = op.node;
      if (!isObj(n)) return 'ADD_NODE.node must be an object';
      if (!NODE_TYPES.has(n.type as string)) return `invalid node type: ${String(n.type)}`;
      if (!isStr(n.label)) return 'node.label must be a non-empty string';
      if (!isStr(n.summary)) return 'node.summary must be a non-empty string';
      if (n.owner !== undefined && n.owner !== 'user' && n.owner !== 'ai') return 'node.owner must be user or ai';
      if (n.anchorTurns !== undefined) {
        if (!Array.isArray(n.anchorTurns) || !n.anchorTurns.every(isTurn)) return 'node.anchorTurns must be positive integers';
      }
      if (n.shift !== undefined) {
        const err = checkShift(n.shift);
        if (err) return err;
      }
      if (op.edges !== undefined) {
        if (!Array.isArray(op.edges)) return 'ADD_NODE.edges must be an array';
        for (const e of op.edges) {
          const err = checkEdge(e);
          if (err) return err;
        }
      }
      return null;
    }
    case 'REINFORCE':
      if (!isStr(op.nodeId)) return 'REINFORCE.nodeId must be a non-empty string';
      if (!isTurn(op.turn)) return 'REINFORCE.turn must be a positive integer';
      return null;
    case 'UPDATE_NODE': {
      if (!isStr(op.nodeId)) return 'UPDATE_NODE.nodeId must be a non-empty string';
      const p = op.patch;
      if (!isObj(p)) return 'UPDATE_NODE.patch must be an object';
      const keys = Object.keys(p);
      if (keys.length === 0) return 'UPDATE_NODE.patch must not be empty';
      for (const k of keys) {
        if (k !== 'label' && k !== 'summary') return `UPDATE_NODE.patch: field not allowed: ${k}`;
        if (!isStr(p[k])) return `UPDATE_NODE.patch.${k} must be a non-empty string`;
      }
      return null;
    }
    case 'MARK_SHIFT':
      if (op.nodeId !== null && !isStr(op.nodeId)) return 'MARK_SHIFT.nodeId must be string or null';
      return checkShift(op.shift);
    case 'SUPERSEDE':
      if (!isStr(op.oldId) || !isStr(op.newId)) return 'SUPERSEDE.oldId/newId must be non-empty strings';
      if (op.oldId === op.newId) return 'SUPERSEDE.oldId and newId must differ';
      return null;
    case 'MERGE':
      if (!isStr(op.fromId) || !isStr(op.intoId)) return 'MERGE.fromId/intoId must be non-empty strings';
      if (op.fromId === op.intoId) return 'MERGE.fromId and intoId must differ';
      return null;
    case 'ADD_EDGE':
      return checkEdge(op.edge);
    case 'DELETE':
      if (!isStr(op.nodeId)) return 'DELETE.nodeId must be a non-empty string';
      return null;
    case 'SKIP':
      return null;
    default:
      return 'unreachable';
  }
}

export function validateOpsShape(input: unknown): ShapeResult {
  if (!isObj(input)) return { ok: false, error: 'output must be a JSON object' };
  const ops = input.ops;
  if (!Array.isArray(ops)) return { ok: false, error: 'output.ops must be an array' };
  if (ops.length === 0) return { ok: false, error: 'output.ops must not be empty (use SKIP)' };
  if (ops.length > MAX_OPS_PER_TURN) {
    return { ok: false, error: `too many ops: ${ops.length} > ${MAX_OPS_PER_TURN}` };
  }
  const hasSkip = ops.some((o) => isObj(o) && o.op === 'SKIP');
  if (hasSkip && ops.length > 1) {
    return { ok: false, error: 'SKIP must be the only op in a batch' };
  }
  for (let i = 0; i < ops.length; i++) {
    const err = checkOp(ops[i]);
    if (err) return { ok: false, error: `ops[${i}]: ${err}` };
  }
  return { ok: true, ops: ops as MapOp[] };
}

export function parseAnalyzerOutput(text: string): ShapeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'output is not valid JSON' };
  }
  return validateOpsShape(parsed);
}