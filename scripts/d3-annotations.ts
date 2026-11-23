import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MapOp, ThoughtNode } from '@thought-atlas/core';
import { RolloutParser, RolloutCursorReader, sessionIdFromRolloutPath } from '@thought-atlas/adapter-codex';
import { AtlasDaemon, DeepSeekClient, FsStorage, loadConfig, atlasHome } from '@thought-atlas/daemon';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/d3-annotations.ts <rollout.jsonl>...');
  process.exit(1);
}

const home = atlasHome();
const config = await loadConfig(home);
const daemon = new AtlasDaemon({
  model: new DeepSeekClient(config),
  home,
  port: 0,
  retryIntervalMs: 0,
  storageFactory: (id) => new FsStorage(id, home),
});

const draftsDir = join(home, 'golden-drafts');
await mkdir(draftsDir, { recursive: true, mode: 0o700 });
await chmod(draftsDir, 0o700);

const TYPE_LABEL: Record<string, string> = {
  claim: '论点',
  question: '问题',
  fact: '事实',
  'ai-voice': 'AI 观点',
  shift: '认知转变',
};

const ADD_REASON: Record<string, string> = {
  claim: '用户提出新的判断或理解',
  question: '用户提出尚未解决的问题',
  fact: '出现值得记住的个人事实/偏好',
  'ai-voice': 'AI 给出影响后续讨论的解释要点',
  shift: '用户明确修订先前立场',
};

interface Aggregate {
  fileId: string;
  turns: number;
  statusCounts: Record<string, number>;
  addNode: number;
  reinforce: number;
  shifts: number;
  skips: number;
  nodes: number;
  edges: number;
  retryRecovered: number;
  annotationPath: string;
}

const aggregates: Aggregate[] = [];

function labelOf(map: Map<string, { label: string; type: string }>, id: string | null | undefined): string {
  if (!id) return '（无）';
  const found = map.get(id);
  return found ? `${found.label}(${id})` : id;
}

for (const file of files) {
  const sessionId = sessionIdFromRolloutPath(file);
  const reader = new RolloutCursorReader(file, 0);
  const parser = new RolloutParser({ sessionId });
  const turns = [];
  for (const line of await reader.readNewLines()) {
    const turn = parser.feedLine(line);
    if (turn) turns.push(turn);
  }
  if (turns.length === 0) {
    console.log(`skip ${file}: no complete turns`);
    continue;
  }

  const storage = new FsStorage(sessionId, home);
  let map = await storage.loadMap();
  const statusCounts: Record<string, number> = {};
  let retryRecovered = 0;
  if (!map || map.lastTurn < turns.length) {
    console.log(`analyzing session=${sessionId} turns=${turns.length}`);
    for (const turn of turns) {
      const result = await daemon.ingest(turn);
      statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
    }
    retryRecovered = (await daemon.runRetryOnce()).recovered;
    map = await storage.loadMap();
  } else {
    console.log(`reuse existing map session=${sessionId} turns=${turns.length}`);
  }
  if (!map) throw new Error(`map missing for ${sessionId}`);

  const events = await storage.loadEvents();
  const idIndex = new Map<string, { label: string; type: string }>();
  for (const node of map.nodes) idIndex.set(node.id, { label: node.label, type: node.type });

  const byTurn = new Map<number, MapOp[]>();
  for (const ev of events) byTurn.set(ev.turnIndex, ev.ops);

  const lines: string[] = [
    `# 黄金样本草稿标注 · ${sessionId}`,
    '',
    '> 本文件由分析器事件反推生成，是待作者确认的草稿；真实对话原文仅在对应的 .md 草稿内（本机，不进仓库）。',
    `> 来源：${file.split('/').pop()} · ${turns.length} 轮 · 模型：${config.model} · 生成时间：${new Date().toISOString()}`,
    '> 标记含义：应记 = 期望新建节点；应合并重述 = 语义重复应加年轮；转变点 = 用户立场真实改变的位置。',
    '',
    '## 逐轮标注',
    '',
  ];

  let addNode = 0;
  let reinforce = 0;
  let shifts = 0;
  let skips = 0;

  for (const turn of turns) {
    const ops = byTurn.get(turn.turnIndex) ?? [];
    lines.push(`### 第 ${turn.turnIndex} 轮`, '');
    if (ops.length === 0) {
      lines.push('- （无事件记录）');
    }
    for (const op of ops) {
      switch (op.op) {
        case 'ADD_NODE': {
          addNode++;
          const node = op.node;
          const typeLabel = TYPE_LABEL[node.type] ?? node.type;
          lines.push(`- 应记 · [${typeLabel}] ${node.label} — ${node.summary}｜理由：${ADD_REASON[node.type] ?? '新信息'}`);
          for (const edge of op.edges ?? []) {
            lines.push(`  - 连接 · ${labelOf(idIndex, edge.from)} → ${labelOf(idIndex, edge.to)}(${edge.kind})`);
          }
          break;
        }
        case 'REINFORCE':
          reinforce++;
          lines.push(`- 应合并重述 · ${labelOf(idIndex, op.nodeId)}｜加年轮（第 ${op.turn} 轮）｜理由：与既有节点语义同一，不新建节点`);
          break;
        case 'MARK_SHIFT':
          shifts++;
          lines.push(
            `- 转变点 · ${op.shift.toSummary}｜from ${labelOf(idIndex, op.shift.fromNodeId)} → trigger ${labelOf(idIndex, op.shift.triggerNodeId)}｜理由：同一议题上用户立场/理解发生改变`,
          );
          break;
        case 'UPDATE_NODE':
          lines.push(`- 更新节点 · ${labelOf(idIndex, op.nodeId)}｜理由：表述被修正`);
          break;
        case 'SUPERSEDE':
          lines.push(`- 取代 · ${labelOf(idIndex, op.oldId)} → ${labelOf(idIndex, op.newId)}｜理由：新表述覆盖旧表述`);
          break;
        case 'MERGE':
          lines.push(`- 合并 · ${labelOf(idIndex, op.fromId)} → ${labelOf(idIndex, op.intoId)}｜理由：同一观点换说法`);
          break;
        case 'ADD_EDGE':
          lines.push(`- 补边 · ${labelOf(idIndex, op.edge.from)} → ${labelOf(idIndex, op.edge.to)}(${op.edge.kind})`);
          break;
        case 'DELETE':
          lines.push(`- 删除 · ${labelOf(idIndex, op.nodeId)}｜理由：内容无效`);
          break;
        case 'SKIP':
          skips++;
          lines.push('- 跳过 · 无值得记录的新内容');
          break;
      }
    }
    lines.push('');
  }

  lines.push(
    '## 汇总',
    '',
    `- 轮数：${turns.length}`,
    `- 应记：${addNode}；应合并重述：${reinforce}；转变点：${shifts}；跳过：${skips}`,
    `- 最终节点：${map.nodes.length}；连线：${map.edges.length}`,
    '',
  );

  const annotationPath = join(draftsDir, `${sessionId}.annotation.md`);
  await writeFile(annotationPath, lines.join('\n'), { mode: 0o600 });
  await chmod(annotationPath, 0o600);
  console.log(`annotation -> ${annotationPath}`);

  const draftPath = join(draftsDir, `${sessionId}.md`);
  let hasDraft = true;
  try {
    await access(draftPath);
  } catch {
    hasDraft = false;
  }
  if (!hasDraft) {
    const draft: string[] = [
      `# 黄金样本候选草稿 · ${sessionId}`,
      '',
      '> 本文件含真实对话原文，仅供作者本机标注，绝不进仓库。标注后按 §10.5 逐段授权。',
      `> 来源：${file.split('/').pop()} · ${turns.length} 轮`,
      '',
      '## 分析器生成的节点（供对照）',
      '',
      ...map.nodes.map(
        (n: ThoughtNode) =>
          `- [${n.type}] ${n.label} — ${n.summary}（born ${n.bornTurn}, rings ${n.rings.join(',')}）`,
      ),
      '',
      '## 逐轮原文（标注：应记节点 / 应合并重述 / 真实转变点）',
      '',
    ];
    for (const turn of turns) {
      draft.push(`### 第 ${turn.turnIndex} 轮`, '', '**用户**：', '', turn.userText, '', '**助手**：', '', turn.assistantText, '');
    }
    await writeFile(draftPath, draft.join('\n'), { mode: 0o600 });
    await chmod(draftPath, 0o600);
    console.log(`draft -> ${draftPath}`);
  }

  aggregates.push({
    fileId: sessionId,
    turns: turns.length,
    statusCounts,
    addNode,
    reinforce,
    shifts,
    skips,
    nodes: map.nodes.length,
    edges: map.edges.length,
    retryRecovered,
    annotationPath,
  });
}

await daemon.stop();

const evidence = {
  date: new Date().toISOString(),
  model: config.model,
  note: '黄金样本标注聚合统计；标注文件与全文草稿只存 ~/.thought-atlas/golden-drafts（本机 600），不进仓库',
  samples: aggregates.map((a) => ({ ...a, annotationPath: undefined, annotationFile: a.annotationPath.split('/').pop() })),
};
await writeFile(join('evidence', 'd3-golden.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log('evidence -> evidence/d3-golden.json');