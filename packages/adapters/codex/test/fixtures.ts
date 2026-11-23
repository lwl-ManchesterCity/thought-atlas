import type { RolloutRecord } from '../src/index.ts';

export const SESSION_ID = 'synthetic-session-0001';

function msg(role: string, text: string): RolloutRecord {
  return {
    timestamp: '2026-11-23T02:00:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] },
  };
}

export function meta(): RolloutRecord {
  return {
    timestamp: '2026-11-23T02:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: { session_id: SESSION_ID, id: SESSION_ID, cwd: '/tmp/synthetic', cli_version: '0.163.0' },
  };
}

export function taskComplete(turnId: string, lastAgentMessage: string): RolloutRecord {
  return {
    timestamp: '2026-11-23T02:01:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      root_turn_id: turnId,
      last_agent_message: lastAgentMessage,
      started_at: '2026-11-23T02:00:30.000Z',
      completed_at: '2026-11-23T02:01:00.000Z',
      duration_ms: 30000,
    },
  };
}

export function noise(): RolloutRecord[] {
  return [
    { type: 'turn_context', payload: { model: 'synthetic-model' } },
    msg('developer', '<user_instructions>合成环境注入文本，必须被排除</user_instructions>'),
    { type: 'response_item', payload: { type: 'reasoning', summary: ['合成推理过程，必须被排除'] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'shell', input: 'echo synthetic-tool-call' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'synthetic-tool-output' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'synthetic-function-output' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: 100 } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'message' } } },
    { type: 'world_state', payload: {} },
  ];
}

export function turn1(): RolloutRecord[] {
  return [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    {
      ...msg('user', '<environment_context>cwd=/tmp 合成环境信息</environment_context>我觉得递归就是函数自己调用自己，没什么难的'),
    },
    ...noise(),
    msg('assistant', '递归的难点在隐式调用栈：每一层都有自己的局部变量和返回地址，层数深了容易栈溢出。'),
    taskComplete('t1', '递归的难点在隐式调用栈。'),
  ];
}

export function turn2(): RolloutRecord[] {
  return [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
    msg('user', '原来如此，我之前想简单了——递归难的不是写法，是脑子里要同时跟踪好几层状态'),
    msg('assistant', '对，这就是为什么画调用栈图有助于理解递归。'),
    taskComplete('t2', '对，画调用栈图有助于理解递归。'),
  ];
}

export function fullFixture(): RolloutRecord[] {
  return [meta(), ...turn1(), ...turn2()];
}