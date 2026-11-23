export type SourcePlatform =
  | 'qoder'
  | 'claude-code'
  | 'zcode'
  | 'codex'
  | 'watcher'
  | 'sandbox';

export interface TurnPayload {
  sessionId: string;
  turnIndex: number;
  userText: string;
  assistantText: string;
  timestamp: string;
  source: SourcePlatform;
}

export type NodeType = 'claim' | 'question' | 'shift' | 'fact' | 'ai-voice';
export type NodeOwner = 'user' | 'ai';
export type NodeStatus = 'active' | 'superseded' | 'merged';

export interface ShiftFields {
  fromNodeId?: string | null;
  toSummary: string;
  triggerNodeId?: string | null;
  triggerTurn?: number;
  retro?: boolean;
}

export interface ThoughtNode {
  id: string;
  type: NodeType;
  owner: NodeOwner;
  label: string;
  summary: string;
  bornTurn: number;
  lastTurn: number;
  rings: number[];
  status: NodeStatus;
  supersededBy: string | null;
  mergedInto: string | null;
  anchorTurns: number[];
  clusterId: string | null;
  manual: boolean;
  shift?: ShiftFields;
}

export type EdgeKind = 'influence' | 'related' | 'supersede';

export interface ThoughtEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  bornTurn: number;
}

export interface NewNode {
  type: NodeType;
  owner?: NodeOwner;
  label: string;
  summary: string;
  anchorTurns?: number[];
  shift?: ShiftFields;
}

export type MapOp =
  | { op: 'ADD_NODE'; node: NewNode; edges?: ThoughtEdge[] }
  | { op: 'REINFORCE'; nodeId: string; turn: number }
  | { op: 'UPDATE_NODE'; nodeId: string; patch: { label?: string; summary?: string } }
  | { op: 'MARK_SHIFT'; nodeId: string | null; shift: ShiftFields }
  | { op: 'SUPERSEDE'; oldId: string; newId: string }
  | { op: 'MERGE'; fromId: string; intoId: string }
  | { op: 'ADD_EDGE'; edge: ThoughtEdge }
  | { op: 'DELETE'; nodeId: string }
  | { op: 'SKIP' };

export interface EventRecord {
  turnIndex: number;
  timestamp: string;
  ops: MapOp[];
}

export interface FailureRecord {
  turnIndex: number;
  timestamp: string;
  reason: string;
}

export interface GraphMap {
  sessionId: string;
  nodes: ThoughtNode[];
  edges: ThoughtEdge[];
  lastTurn: number;
}

export interface SkeletonNode {
  id: string;
  type: NodeType;
  label: string;
  summary: string;
  lastTurn: number;
}

export interface SessionMeta {
  sessionId: string;
  title: string;
  source: SourcePlatform;
  createdAt: string;
}

export const MAX_OPS_PER_TURN = 5;
export const LABEL_MAX = 16;
export const SUMMARY_MAX = 60;