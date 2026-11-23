import type {
  EventRecord,
  FailureRecord,
  GraphMap,
  SessionMeta,
  TurnPayload,
} from './types.ts';

export interface Storage {
  appendTurn(payload: TurnPayload): Promise<void>;
  appendEvent(record: EventRecord): Promise<void>;
  appendFailure(record: FailureRecord): Promise<void>;
  saveMap(map: GraphMap): Promise<void>;
  loadMap(): Promise<GraphMap | null>;
  loadEvents(): Promise<EventRecord[]>;
  saveMeta(meta: SessionMeta): Promise<void>;
}

export interface ModelRequest {
  system: string;
  user: string;
  jsonMode: boolean;
  temperature: number;
  timeoutMs: number;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ModelResponse {
  text: string;
  usage: ModelUsage;
  latencyMs: number;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface GraphUpdate {
  sessionId: string;
  turnIndex: number;
  map: GraphMap;
}

export interface Transport {
  publish(update: GraphUpdate): void;
}