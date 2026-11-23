import type { TurnPayload } from '@thought-atlas/core';

export interface RolloutRecord {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

const WRAPPER_TAGS = ['environment_context', 'user_instructions'];

function stripWrappers(text: string): string {
  let out = text;
  for (const tag of WRAPPER_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
  }
  return out.trim();
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join('\n');
}

export function sessionIdFromRolloutPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/^rollout-/, '').replace(/\.jsonl$/, '');
}

export class RolloutParser {
  private sessionId: string | null;
  private sessionIdLocked: boolean;
  private turnIndex = 0;
  private userTexts: string[] = [];
  private assistantTexts: string[] = [];
  private seenTurnIds = new Set<string>();

  constructor(options: { sessionId?: string } = {}) {
    this.sessionId = options.sessionId ?? null;
    this.sessionIdLocked = options.sessionId !== undefined;
  }

  feedLine(line: string): TurnPayload | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let record: RolloutRecord;
    try {
      record = JSON.parse(trimmed) as RolloutRecord;
    } catch {
      return null;
    }
    return this.feed(record);
  }

  feed(record: RolloutRecord): TurnPayload | null {
    const payload = record.payload;
    if (!payload) return null;

    if (record.type === 'session_meta') {
      const id = payload.session_id ?? payload.id;
      if (!this.sessionIdLocked && typeof id === 'string' && id.length > 0) this.sessionId = id;
      return null;
    }

    if (record.type === 'response_item' && payload.type === 'message') {
      const role = payload.role;
      const text = extractText(payload.content);
      if (role === 'user') {
        const cleaned = stripWrappers(text);
        if (cleaned) this.userTexts.push(cleaned);
      } else if (role === 'assistant') {
        if (text.trim()) this.assistantTexts.push(text);
      }
      return null;
    }

    if (record.type === 'event_msg' && payload.type === 'task_complete') {
      const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
      if (turnId && this.seenTurnIds.has(turnId)) return null;
      if (turnId) this.seenTurnIds.add(turnId);
      if (!this.sessionId) return null;

      this.turnIndex++;
      const userText = this.userTexts.join('\n');
      const lastAgentMessage = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
      const assistantText = this.assistantTexts.join('\n') || lastAgentMessage;
      this.userTexts = [];
      this.assistantTexts = [];

      const timestamp =
        (typeof payload.completed_at === 'string' && payload.completed_at) ||
        record.timestamp ||
        new Date().toISOString();

      return {
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        userText,
        assistantText,
        timestamp,
        source: 'codex',
      };
    }

    return null;
  }
}