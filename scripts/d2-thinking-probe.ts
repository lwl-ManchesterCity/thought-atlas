import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { SYSTEM_PROMPT, buildUserMessage, parseAnalyzerOutput } from '@thought-atlas/core';
import type { TurnPayload } from '@thought-atlas/core';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(join(homedir(), '.thought-atlas', 'config.json'), 'utf8'));

const payload: TurnPayload = {
  sessionId: 'd2-thinking-probe',
  turnIndex: 3,
  userText: '等等，你说 Python 和 Java 也一样？那我之前的想法错了——我本来以为这是 JS 独有的 bug，听你讲完 IEEE754 才明白，这是所有语言共有的精度取舍，不是谁写得烂。这个解释让我想通了。',
  assistantText: '对，你抓住关键了：二进制无法精确表示大多数十进制小数，这是表示法的固有限制。判断相等要用容忍度，涉及钱的场景要用整数分或十进制类型。',
  timestamp: new Date().toISOString(),
  source: 'sandbox',
};

const user = buildUserMessage({
  payload,
  skeleton: [
    { id: 'n_0001', type: 'claim', label: '浮点误差是JS的bug', summary: '用户认为0.1+0.2≠0.3是JS实现缺陷', lastTurn: 1 },
    { id: 'n_0002', type: 'question', label: '为何0.1+0.2不等于0.3', summary: '用户询问浮点误差的原因', lastTurn: 1 },
  ],
  recentSummaries: [],
});

async function probe(thinking: 'enabled' | 'disabled') {
  const started = Date.now();
  const res = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
      thinking: { type: thinking },
      max_tokens: 2000,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    choices: { message: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  const latencyMs = Date.now() - started;
  const message = data.choices?.[0]?.message ?? {};
  const parsed = parseAnalyzerOutput(message.content ?? '');
  return {
    thinking,
    latencyMs,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    reasoningChars: (message.reasoning_content ?? '').length,
    finishReason: data.choices?.[0]?.finish_reason,
    jsonValid: parsed.ok,
    ops: parsed.ok ? parsed.ops.map((o: { op: string }) => o.op) : null,
  };
}

const enabled = await probe('enabled');
const disabled = await probe('disabled');
const result = { runAt: new Date().toISOString(), model: config.model, enabled, disabled };
await writeFile(join(repoRoot, 'evidence', 'd2-thinking-probe.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));