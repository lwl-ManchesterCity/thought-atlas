import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { GraphMap } from '@thought-atlas/core';
import { mapSignature } from '../packages/web/src/graph-model.ts';

const CONFIG = join(homedir(), '.thought-atlas', 'config.json');
const config = JSON.parse(await readFile(CONFIG, 'utf8')) as { qoderWatch?: string[] };
const TRANSCRIPT = process.env.ATLAS_QODER_TRANSCRIPT ?? config.qoderWatch?.find((t) => t.endsWith('.jsonl'));
if (!TRANSCRIPT) throw new Error('config.json 的 qoderWatch 未配置 transcript 绝对路径');
const SESSION = `qoder-${basename(TRANSCRIPT, '.jsonl')}`;
const BASE = 'http://127.0.0.1:7788';
const EVIDENCE = fileURLToPath(new URL('../evidence/d5-real.json', import.meta.url));

const codexBaselines: Record<string, { nodes: number; edges: number; lastTurn: number; sha: string }> = {
  '2026-10-19T10-59-52-01a15219-e9be-78a0-912b-106544f45649': { nodes: 16, edges: 2, lastTurn: 42, sha: 'c75fce8000f5' },
  '2026-11-17T11-18-01-01a175c9-8f74-7052-a1b7-1b9cc7ef1360_01a1e782-f5c4-79e1-ad81-7e71f6e45585': {
    nodes: 5,
    edges: 3,
    lastTurn: 16,
    sha: '1882f976eb01',
  },
  '2026-11-19T19-35-57-01a175c9-8f74-7052-a1b7-1b9cc7ef1360_01a1f397-8b60-7503-9286-8979f9fbfae0': {
    nodes: 18,
    edges: 6,
    lastTurn: 44,
    sha: 'eb6d5d2992d4',
  },
};

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

function sha12(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

const transcriptStat = await stat(TRANSCRIPT);
let lines = 0;
let humanRows = 0;
for (const line of (await readFile(TRANSCRIPT, 'utf8')).split('\n')) {
  if (!line.trim()) continue;
  lines++;
  try {
    const record = JSON.parse(line) as { type?: string; origin?: { kind?: string }; isSidechain?: boolean };
    if (record.type === 'user' && record.origin?.kind === 'human' && record.isSidechain !== true) humanRows++;
  } catch {
    // 合成/真实探测只统计可解析记录
  }
}

const replay = await json<{
  lastTurn: number;
  steps: { turnIndex: number; opsCount: number }[];
}>(`/replay?sessionId=${SESSION}`);
const live = await json<GraphMap>(`/map?sessionId=${SESSION}`);
const snapshot = await json<{ map: GraphMap }>(`/replay/snapshot?sessionId=${SESSION}`);
const liveSig = mapSignature(live);
const replaySig = mapSignature(snapshot.map);

const codex = [];
let codexUnchanged = true;
for (const [sessionId, baseline] of Object.entries(codexBaselines)) {
  const map = await json<GraphMap>(`/map?sessionId=${sessionId}`);
  const mapPath = join(homedir(), '.thought-atlas', 'sessions', sessionId, 'map.json');
  const sha = sha12(await readFile(mapPath, 'utf8'));
  const unchanged =
    map.nodes.length === baseline.nodes &&
    map.edges.length === baseline.edges &&
    map.lastTurn === baseline.lastTurn &&
    sha === baseline.sha;
  if (!unchanged) codexUnchanged = false;
  codex.push({ nodes: map.nodes.length, edges: map.edges.length, lastTurn: map.lastTurn, unchanged });
}

const types: Record<string, number> = {};
for (const node of live.nodes) types[node.type] = (types[node.type] ?? 0) + 1;

const evidence = {
  real: true,
  synthetic: false,
  transcript: {
    lines,
    humanRows,
    sizeBytes: transcriptStat.size,
  },
  adapter: {
    source: 'qoder',
    mappedSession: true,
    steps: replay.steps.length,
    turnIndexes: replay.steps.map((step) => step.turnIndex),
    opsPerStep: replay.steps.map((step) => step.opsCount),
  },
  graph: {
    nodes: live.nodes.length,
    edges: live.edges.length,
    lastTurn: live.lastTurn,
    typeCounts: types,
  },
  replay: {
    lastTurn: replay.lastTurn,
    finalMapMatchesLive: liveSig === replaySig,
    signatureHash: sha12(liveSig),
  },
  inProgressTurnExcluded: humanRows - replay.steps.length,
  codexMapsUnchanged: codexUnchanged,
  codexSessionsChecked: codex.length,
};

if (!evidence.replay.finalMapMatchesLive || !codexUnchanged) {
  throw new Error('real verification assertions failed');
}
await import('node:fs/promises').then((fs) => fs.writeFile(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n'));
console.log(JSON.stringify(evidence, null, 2));