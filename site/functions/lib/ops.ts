import type { MapOp } from './core/types.ts';

// 缓存里保留的是语义决策；重放时把上一轮的轮次号改绑到当前轮
export function rebindTurnFields(ops: MapOp[], fromTurn: number, toTurn: number): MapOp[] {
  const clone = structuredClone(ops);
  for (const op of clone) {
    if (op.op === 'REINFORCE' && op.turn === fromTurn) op.turn = toTurn;
    if (op.op === 'MARK_SHIFT' && op.shift.triggerTurn === fromTurn) op.shift.triggerTurn = toTurn;
    if (op.op === 'ADD_NODE') {
      if (op.node.anchorTurns) {
        op.node.anchorTurns = op.node.anchorTurns.map((t) => (t === fromTurn ? toTurn : t));
      }
      for (const edge of op.edges ?? []) {
        if (edge.bornTurn === fromTurn) edge.bornTurn = toTurn;
      }
    }
    if (op.op === 'ADD_EDGE' && op.edge.bornTurn === fromTurn) op.edge.bornTurn = toTurn;
  }
  return clone;
}