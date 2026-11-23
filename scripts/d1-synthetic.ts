import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ThoughtGraph,
  analyzeTurn,
  filterTurn,
} from '@thought-atlas/core';
import type { RecentSummary, TurnPayload } from '@thought-atlas/core';
import { FsStorage, DeepSeekClient, atlasHome } from '@thought-atlas/daemon';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sessionId = process.argv[2] ?? `d1-synthetic-${Date.now().toString(36)}`;
const evidenceTag = process.argv[3] ?? 'd1';

const turns: Omit<TurnPayload, 'sessionId' | 'timestamp' | 'source'>[] = [
  {
    turnIndex: 1,
    userText: '我在学 JavaScript，发现 0.1 + 0.2 竟然不等于 0.3。我一直觉得这就是 JS 写得烂，是个随机出现的 bug，别的语言应该没这种问题。为什么会这样？',
    assistantText: '这不是 JS 特有的 bug，几乎所有主流语言（Python、Java、C++）都一样。根源是 IEEE754 双精度浮点：0.1 和 0.2 在二进制里是无限循环小数，只能截断存储，相加后误差累积成 0.30000000000000004。这是用有限位数换表示范围的精度取舍，不是实现缺陷。',
  },
  {
    turnIndex: 2,
    userText: '好的，继续',
    assistantText: '那我们接着看：如果要在代码里比较两个浮点数是否相等，通常用误差容忍度（epsilon）的方式，比如 Math.abs(a - b) < Number.EPSILON。',
  },
  {
    turnIndex: 3,
    userText: '等等，你说 Python 和 Java 也一样？那我之前的想法错了——我本来以为这是 JS 独有的 bug，听你讲完 IEEE754 才明白，这是所有语言共有的精度取舍，不是谁写得烂。这个解释让我想通了。',
    assistantText: '对，你抓住关键了：二进制无法精确表示大多数十进制小数，这是表示法的固有限制。判断相等要用容忍度，涉及钱的场景要用整数分或十进制类型。',
  },
  {
    turnIndex: 4,
    userText: '所以 0.1+0.2 不等于 0.3 本质上就是精度问题嘛，不是语言缺陷，我之前怪 JS 怪错了。',
    assistantText: '没错，这正是 IEEE754 精度取舍的直接体现。你已经把这个概念内化了。',
  },
];

interface TurnReport {
  turnIndex: number;
  filtered: boolean;
  filterReason?: string;
  analyzeOk?: boolean;
  analyzeReason?: string;
  attempts?: number;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  opsApplied?: number;
  duplicate?: boolean;
}

const storage = new FsStorage(sessionId);
const model = await DeepSeekClient.fromConfig();
const graph = await ThoughtGraph.load(sessionId, storage);
await storage.saveMeta({
  sessionId,
  title: 'D1 合成学习场景：浮点误差的理解转变',
  source: 'sandbox',
  createdAt: new Date().toISOString(),
});

const reports: TurnReport[] = [];
const recent: RecentSummary[] = [];
let previous: TurnPayload | undefined;

for (const t of turns) {
  const payload: TurnPayload = {
    ...t,
    sessionId,
    timestamp: new Date().toISOString(),
    source: 'sandbox',
  };
  await storage.appendTurn(payload);
  const report: TurnReport = { turnIndex: t.turnIndex, filtered: false };

  const filtered = filterTurn(payload, previous);
  previous = payload;

  if (filtered.skip) {
    report.filtered = true;
    report.filterReason = filtered.reason;
    await graph.applyTurn(payload.turnIndex, [{ op: 'SKIP' }], payload.timestamp);
    reports.push(report);
    console.log(`turn ${t.turnIndex}: FILTER SKIP (${filtered.reason})`);
    continue;
  }

  const result = await analyzeTurn({
    payload,
    skeleton: graph.skeleton(),
    recentSummaries: recent,
    model,
  });
  report.attempts = result.attempts;
  report.latencyMs = result.latencyMs;
  report.promptTokens = result.usage?.promptTokens;
  report.completionTokens = result.usage?.completionTokens;

  if (!result.ok) {
    report.analyzeOk = false;
    report.analyzeReason = result.reason;
    await storage.appendFailure({
      turnIndex: payload.turnIndex,
      timestamp: payload.timestamp,
      reason: result.reason,
    });
    reports.push(report);
    console.log(`turn ${t.turnIndex}: ANALYZE FAILED (${result.reason})`);
    continue;
  }

  report.analyzeOk = true;
  const applied = await graph.applyTurn(payload.turnIndex, result.ops, payload.timestamp);
  report.opsApplied = applied.ops?.length ?? 0;
  report.duplicate = applied.duplicate;
  if (!applied.ok) {
    report.analyzeOk = false;
    report.analyzeReason = `graph rejected: ${applied.reason}`;
  }
  const labels = (applied.ops ?? [])
    .flatMap((op) => (op.op === 'ADD_NODE' ? [op.node.label] : []))
    .join('、');
  recent.push({
    turnIndex: payload.turnIndex,
    summary: labels || result.ops.map((o) => o.op).join(','),
  });
  if (recent.length > 2) recent.shift();
  reports.push(report);
  console.log(
    `turn ${t.turnIndex}: ${result.ops.map((o) => o.op).join(', ')} | ${result.latencyMs}ms | tokens ${result.usage?.promptTokens}+${result.usage?.completionTokens}`,
  );
}

const map = graph.getMap();
const totalPrompt = reports.reduce((s, r) => s + (r.promptTokens ?? 0), 0);
const totalCompletion = reports.reduce((s, r) => s + (r.completionTokens ?? 0), 0);
const evidence = {
  runAt: new Date().toISOString(),
  sessionId,
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  synthetic: true,
  turns: reports,
  totalPromptTokens: totalPrompt,
  totalCompletionTokens: totalCompletion,
  totalLatencyMs: reports.reduce((s, r) => s + (r.latencyMs ?? 0), 0),
  mapStats: {
    nodes: map.nodes.length,
    edges: map.edges.length,
    shifts: map.nodes.filter((n) => n.type === 'shift').length,
    influenceEdges: map.edges.filter((e) => e.kind === 'influence').length,
  },
};

const evidenceDir = join(repoRoot, 'evidence');
await mkdir(join(evidenceDir, `${evidenceTag}-synthetic`), { recursive: true });
await writeFile(join(evidenceDir, `${evidenceTag}-deepseek-run.json`), JSON.stringify(evidence, null, 2));
const sessionDir = join(atlasHome(), 'sessions', sessionId);
for (const file of ['map.json', 'events.jsonl', 'turns.jsonl', 'meta.json']) {
  await copyFile(join(sessionDir, file), join(evidenceDir, `${evidenceTag}-synthetic`, file));
}

console.log('\n=== D1 synthetic run summary ===');
console.log(JSON.stringify(evidence.mapStats));
console.log(`total tokens: ${totalPrompt} prompt + ${totalCompletion} completion`);
console.log(`evidence: evidence/${evidenceTag}-deepseek-run.json, evidence/${evidenceTag}-synthetic/`);
const allOk = reports.every((r) => r.filtered || r.analyzeOk);
if (!allOk) {
  console.error('some turns failed analysis');
  process.exit(1);
}