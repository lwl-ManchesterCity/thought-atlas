import { createHash } from 'node:crypto';
import type { TurnPayload } from '@thought-atlas/core';
import type { TranscriptParser } from '@thought-atlas/adapter-watcher';

const WRAPPER_TAGS = ['system-reminder', 'environment_context', 'user_instructions', 'qoder_delegated_input_sources'];
const STATE_VERSION = 1;

interface PendingTurn {
  id: string;
  turnIndex: number;
  userText: string;
  timestamp: string;
  lastText: string;
  finalText: string;
  endTurnSeen: boolean;
}

interface QoderParserState {
  version: number;
  humanIds: Record<string, number>;
  nextTurnIndex: number;
  pending: PendingTurn | null;
}

interface QoderOptions {
  sessionId?: string;
  state?: unknown;
  reparse?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stripWrappers(text: string): string {
  let out = text;
  for (const tag of WRAPPER_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
  }
  return out.trim();
}

function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts;
}

function humanText(record: Record<string, unknown>): string {
  const humanInput = asRecord(record.humanInput);
  const direct = humanInput ? stringOf(humanInput.text) : '';
  const raw = direct || textBlocks(asRecord(record.message)?.content).join('\n');
  return stripWrappers(raw);
}

function assistantText(record: Record<string, unknown>): string {
  return textBlocks(asRecord(record.message)?.content).join('\n').trim();
}

export function normalizeTimestamp(value: unknown): string | null {
  let ms: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    ms = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string' && value.trim()) {
    ms = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

export function humanIdFor(record: Record<string, unknown>, text: string): string {
  const uuid = stringOf(record.uuid);
  if (uuid) return uuid;
  const promptId = stringOf(record.promptId);
  if (promptId) return promptId;
  return 'hash-' + createHash('sha1').update(`${stringOf(record.timestamp)}\0${text}`).digest('hex');
}

export function qoderSessionIdFromPath(path: string): string {
  const base = (path.split('/').pop() ?? '').replace(/\.jsonl$/, '');
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '') || 'unknown';
  return `qoder-${clean}`;
}

export class QoderParser implements TranscriptParser {
  private sessionId: string;
  private humanIds = new Map<string, number>();
  private nextTurnIndex = 1;
  private pending: PendingTurn | null = null;

  constructor(options: QoderOptions) {
    this.sessionId = options.sessionId ?? 'qoder-unknown';
    if (options.state) this.restore(options.state, options.reparse === true);
  }

  feedLine(line: string): TurnPayload | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return null;
    }
    return this.feed(record);
  }

  feed(record: Record<string, unknown>): TurnPayload | null {
    if (record.isSidechain === true) return null;
    if (record.type === 'user') return this.feedUser(record);
    if (record.type === 'assistant') return this.feedAssistant(record);
    return null;
  }

  snapshot(): QoderParserState {
    const humanIds: Record<string, number> = {};
    for (const [id, index] of this.humanIds) humanIds[id] = index;
    return {
      version: STATE_VERSION,
      humanIds,
      nextTurnIndex: this.nextTurnIndex,
      pending: this.pending ? { ...this.pending } : null,
    };
  }

  private restore(state: unknown, reparse: boolean): void {
    const s = asRecord(state);
    if (!s || s.version !== STATE_VERSION) return;
    const ids = asRecord(s.humanIds);
    if (ids) {
      for (const [id, index] of Object.entries(ids)) {
        if (typeof index === 'number' && Number.isInteger(index) && index >= 1) this.humanIds.set(id, index);
      }
    }
    let maxIndex = 0;
    for (const index of this.humanIds.values()) maxIndex = Math.max(maxIndex, index);
    const storedNext = typeof s.nextTurnIndex === 'number' && Number.isInteger(s.nextTurnIndex) ? s.nextTurnIndex : 1;
    this.nextTurnIndex = Math.max(storedNext, maxIndex + 1);
    if (reparse) return;
    const p = asRecord(s.pending);
    if (!p) return;
    const id = stringOf(p.id);
    const turnIndex = typeof p.turnIndex === 'number' && Number.isInteger(p.turnIndex) ? p.turnIndex : 0;
    const userText = stringOf(p.userText);
    if (!id || turnIndex < 1 || !userText) return;
    this.pending = {
      id,
      turnIndex,
      userText,
      timestamp: normalizeTimestamp(p.timestamp) ?? new Date().toISOString(),
      lastText: stringOf(p.lastText),
      finalText: stringOf(p.finalText),
      endTurnSeen: p.endTurnSeen === true,
    };
    this.nextTurnIndex = Math.max(this.nextTurnIndex, turnIndex + 1);
  }

  private feedUser(record: Record<string, unknown>): TurnPayload | null {
    const origin = asRecord(record.origin);
    if (origin?.kind !== 'human') return null;
    if (record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) return null;
    const text = humanText(record);
    if (!text) return null;

    const emitted = this.finalize();
    const id = humanIdFor(record, text);
    if (this.humanIds.has(id)) return emitted;

    const turnIndex = this.nextTurnIndex++;
    this.humanIds.set(id, turnIndex);
    this.pending = {
      id,
      turnIndex,
      userText: text,
      timestamp: normalizeTimestamp(record.timestamp) ?? new Date().toISOString(),
      lastText: '',
      finalText: '',
      endTurnSeen: false,
    };
    return emitted;
  }

  private feedAssistant(record: Record<string, unknown>): TurnPayload | null {
    if (!this.pending) return null;
    const message = asRecord(record.message);
    if (!message || message.role !== 'assistant') return null;
    const text = assistantText(record);
    if (text) this.pending.lastText = text;
    if (message.stop_reason === 'end_turn') {
      this.pending.endTurnSeen = true;
      this.pending.finalText = text || this.pending.lastText;
      return this.finalize();
    }
    return null;
  }

  private finalize(): TurnPayload | null {
    const p = this.pending;
    if (!p) return null;
    this.pending = null;
    return {
      sessionId: this.sessionId,
      turnIndex: p.turnIndex,
      userText: p.userText,
      assistantText: (p.finalText || p.lastText).trim(),
      timestamp: p.timestamp,
      source: 'qoder',
    };
  }
}