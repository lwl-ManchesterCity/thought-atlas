import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelClient, ModelRequest, ModelResponse } from '@thought-atlas/core';
import { RolloutParser, RolloutCursorReader, sessionIdFromRolloutPath } from '@thought-atlas/adapter-codex';
import { AtlasDaemon, DeepSeekClient, FsStorage, loadConfig, atlasHome } from '@thought-atlas/daemon';

class MeteredModel implements ModelClient {
  private inner: ModelClient;
  promptTokens = 0;
  completionTokens = 0;
  calls = 0;

  constructor(inner: ModelClient) {
    this.inner = inner;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const res = await this.inner.complete(request);
    this.calls++;
    this.promptTokens += res.usage.promptTokens;
    this.completionTokens += res.usage.completionTokens;
    return res;
  }
}

interface SessionStats {
  sessionId: string;
  rolloutFile: string;
  turnsParsed: number;
  statusCounts: Record<string, number>;
  skipRate: number;
  opsDistribution: Record<string, number>;
  nodesByType: Record<string, number>;
  edgesByKind: Record<string, number>;
  shiftCount: number;
  turnLatencyMs: { avg: number; max: number };
  modelCalls: number;
  tokens: { prompt: number; completion: number };
  estimatedCostUpperBoundYuan: number;
  retryRecovered: number;
  typeGuess: string;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/d2-real-dryrun.ts <rollout.jsonl>...');
  process.exit(1);
}

const home = atlasHome();
const config = await loadConfig(home);
const metered = new MeteredModel(new DeepSeekClient(config));
const daemon = new AtlasDaemon({
  model: metered,
  home,
  port: 0,
  retryIntervalMs: 0,
  storageFactory: (id) => new FsStorage(id, home),
});

const draftsDir = join(home, 'golden-drafts');
await mkdir(draftsDir, { recursive: true, mode: 0o700 });
await chmod(draftsDir, 0o700);

const allStats: SessionStats[] = [];

for (const file of files) {
  const reader = new RolloutCursorReader(file, 0);
  const parser = new RolloutParser({ sessionId: sessionIdFromRolloutPath(file) });
  const turns = [];
  for (const line of await reader.readNewLines()) {
    const turn = parser.feedLine(line);
    if (turn) turns.push(turn);
  }
  if (turns.length === 0) {
    console.log(`skip ${file}: no complete turns`);
    continue;
  }
  const sessionId = turns[0].sessionId;
  console.log(`analyzing session=${sessionId} turns=${turns.length}`);

  const callsBefore = metered.calls;
  const tokensBefore = { p: metered.promptTokens, c: metered.completionTokens };
  const statusCounts: Record<string, number> = {};
  const latencies: number[] = [];
  for (const turn of turns) {
    const t0 = Date.now();
    const result = await daemon.ingest(turn);
    latencies.push(Date.now() - t0);
    statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
    console.log(`  turn ${turn.turnIndex}: ${result.status} (${latencies[latencies.length - 1]}ms)`);
  }
  const retryStats = await daemon.runRetryOnce();

  const storage = new FsStorage(sessionId, home);
  const map = await storage.loadMap();
  const events = await storage.loadEvents();
  const opsDistribution: Record<string, number> = {};
  for (const ev of events) {
    for (const op of ev.ops) opsDistribution[op.op] = (opsDistribution[op.op] ?? 0) + 1;
  }
  const nodesByType: Record<string, number> = {};
  for (const n of map?.nodes ?? []) nodesByType[n.type] = (nodesByType[n.type] ?? 0) + 1;
  const edgesByKind: Record<string, number> = {};
  for (const e of map?.edges ?? []) edgesByKind[e.kind] = (edgesByKind[e.kind] ?? 0) + 1;

  const skipped = statusCounts.skipped ?? 0;
  const thinking = (nodesByType.question ?? 0) + (nodesByType.shift ?? 0) + (nodesByType.claim ?? 0);
  const factual = nodesByType.fact ?? 0;
  const typeGuess = thinking === 0 && factual === 0
    ? '无节点（待人工判断）'
    : thinking >= factual * 2
      ? '学习/讨论型（观点问题转变为主）'
      : factual >= thinking * 2
        ? '任务/操作型（事实为主）'
        : '混合型';

  const prompt = metered.promptTokens - tokensBefore.p;
  const completion = metered.completionTokens - tokensBefore.c;
  const stats: SessionStats = {
    sessionId,
    rolloutFile: file.split('/').pop() ?? file,
    turnsParsed: turns.length,
    statusCounts,
    skipRate: Math.round((skipped / turns.length) * 100) / 100,
    opsDistribution,
    nodesByType,
    edgesByKind,
    shiftCount: nodesByType.shift ?? 0,
    turnLatencyMs: {
      avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      max: Math.max(...latencies),
    },
    modelCalls: metered.calls - callsBefore,
    tokens: { prompt, completion },
    estimatedCostUpperBoundYuan: Math.round(((prompt * 2 + completion * 8) / 1_000_000) * 10000) / 10000,
    retryRecovered: retryStats.recovered,
    typeGuess,
  };
  allStats.push(stats);

  const lines: string[] = [
    `# 黄金样本候选草稿 · ${sessionId}`,
    '',
    '> 本文件含真实对话原文，仅供作者本机标注，绝不进仓库。标注后按 §10.5 逐段授权。',
    `> 来源：${stats.rolloutFile} · ${turns.length} 轮 · 类型推测：${typeGuess}`,
    '',
    '## 分析器生成的节点（供对照）',
    '',
  ];
  for (const n of map?.nodes ?? []) {
    lines.push(`- [${n.type}] ${n.label} — ${n.summary}（born ${n.bornTurn}, rings ${n.rings.join(',')}）`);
  }
  lines.push('', '## 逐轮原文（标注：应记节点 / 应合并重述 / 真实转变点）', '');
  for (const turn of turns) {
    lines.push(`### 第 ${turn.turnIndex} 轮`, '', '**用户**：', '', turn.userText, '', '**助手**：', '', turn.assistantText, '');
  }
  const draftPath = join(draftsDir, `${sessionId}.md`);
  await writeFile(draftPath, lines.join('\n'), { mode: 0o600 });
  await chmod(draftPath, 0o600);
  console.log(`  draft -> ${draftPath}`);
}

await daemon.stop();

const evidence = {
  date: new Date().toISOString(),
  model: config.model,
  note: '聚合统计证据；真实对话正文只存 ~/.thought-atlas/（本机），不进仓库',
  costRateUpperBound: { promptYuanPerMToken: 2, completionYuanPerMToken: 8 },
  sessions: allStats,
  goldenCandidates: allStats.map((s) => ({ sessionId: s.sessionId, turns: s.turnsParsed, typeGuess: s.typeGuess })),
};
await writeFile(join('evidence', 'd2-real-dryrun.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log('evidence -> evidence/d2-real-dryrun.json');