export const SESSION_ID = 'synthetic-qoder-0001';

export interface Block {
  type: string;
  text?: string;
  name?: string;
}

export function human(id: string, text: string, timestamp: string | number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user',
    uuid: id,
    promptId: `prompt-${id}`,
    timestamp,
    isSidechain: false,
    origin: { kind: 'human' },
    humanInput: { text },
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  };
}

export function toolResult(id: string, timestamp: string | number): Record<string, unknown> {
  return {
    type: 'user',
    uuid: id,
    timestamp,
    isSidechain: false,
    origin: { kind: 'tool' },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '合成工具结果必须排除' }],
    },
    toolUseResult: { output: '合成工具结果必须排除' },
  };
}

export function assistant(
  messageId: string,
  stopReason: string | null,
  blocks: Block[],
  timestamp: string | number,
  uuid: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp,
    isSidechain: false,
    responseGroupId: messageId,
    message: { id: messageId, role: 'assistant', stop_reason: stopReason, content: blocks },
    ...extra,
  };
}

export function attachment(id: string, timestamp: string | number): Record<string, unknown> {
  return {
    type: 'attachment',
    uuid: id,
    timestamp,
    isSidechain: false,
    attachment: { kind: 'screenshot', text: '合成附件正文必须排除' },
  };
}

export function turn1(): Record<string, unknown>[] {
  return [
    human('human-1', '合成第一轮用户发言：我想理解递归为什么难，是不是因为要同时记住很多层？', 1800000000),
    toolResult('tool-1', '2026-11-23T04:00:01.000Z'),
    assistant('msg-1', null, [{ type: 'thinking', text: '合成思考内容必须排除' }], '2026-11-23T04:00:02.000Z', 'asst-1'),
    assistant('msg-1', null, [{ type: 'text', text: '合成流式中间片段' }, { type: 'tool_use', name: '合成工具调用必须排除' }], '2026-11-23T04:00:03.000Z', 'asst-2'),
    assistant(
      'msg-1',
      'end_turn',
      [{ type: 'thinking', text: '合成末段思考必须排除' }, { type: 'text', text: '合成第一轮最终回答：递归难在隐式调用栈，每一层都有自己的状态。' }],
      '2026-11-23T04:00:04.000Z',
      'asst-3',
    ),
    attachment('att-1', '2026-11-23T04:00:05.000Z'),
  ];
}

export function turn2(): Record<string, unknown>[] {
  return [
    human('human-2', '合成第二轮用户发言：那我应该怎么练习，才能不丢层？', '2026-11-23T04:05:00.000Z'),
    assistant('msg-2', 'end_turn', [{ type: 'text', text: '合成第二轮最终回答：先画小规模调用栈，再逐层展开。' }], '2026-11-23T04:05:10.000Z', 'asst-4'),
  ];
}

export function interruptedTurn(): Record<string, unknown>[] {
  return [
    human('human-int', '合成被打断的用户发言：先别展开，我换个问题。', '2026-11-23T04:10:00.000Z'),
    assistant('msg-int', 'tool_use', [{ type: 'text', text: '合成被打断前留下的非空正文' }], '2026-11-23T04:10:02.000Z', 'asst-int'),
  ];
}

export function sidechainNoise(): Record<string, unknown>[] {
  return [
    human('human-side', '合成侧链用户发言必须跳过', '2026-11-23T04:06:00.000Z', { isSidechain: true }),
    assistant('msg-side', 'end_turn', [{ type: 'text', text: '合成侧链回答必须跳过' }], '2026-11-23T04:06:10.000Z', 'asst-side', {
      isSidechain: true,
    }),
    assistant('msg-compact', 'end_turn', [{ type: 'text', text: '合成压缩摘要必须排除' }], '2026-11-23T04:06:20.000Z', 'asst-compact', {
      type: 'assistant',
    }),
    {
      type: 'system',
      uuid: 'sys-1',
      isSidechain: false,
      isCompactSummary: true,
      compactMetadata: { trigger: 'auto' },
      timestamp: '2026-11-23T04:06:30.000Z',
    },
  ];
}

export function turn3(): Record<string, unknown>[] {
  return [
    human('human-3', '合成第三轮用户发言：把刚才的调用栈画成图看看。', '2026-11-23T04:12:00.000Z'),
    assistant('msg-3', 'end_turn', [{ type: 'text', text: '合成第三轮最终回答：已把三层调用栈画成节点与边。' }], '2026-11-23T04:12:10.000Z', 'asst-5'),
  ];
}

export function lines(records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}