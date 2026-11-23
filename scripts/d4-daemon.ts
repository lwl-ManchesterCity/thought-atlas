import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  MapOp,
  ModelClient,
  ModelRequest,
  ModelResponse,
  NodeType,
} from '@thought-atlas/core';
import { ThoughtGraph } from '@thought-atlas/core';
import { AtlasDaemon, FsStorage } from '@thought-atlas/daemon';

const REPLAY_SESSION = 'd4-replay-300';
const XSS_SESSION = 'd4-anchor-xss';
const MANUAL_SESSION = 'd4-manual-3';

const home = process.env.ATLAS_D4_HOME ?? join(homedir(), '.thought-atlas-d4');
const port = Number(process.env.ATLAS_D4_PORT ?? 7803);
const webDir = process.env.ATLAS_WEB_DIR ?? fileURLToPath(new URL('../packages/web/dist', import.meta.url));

const stubModel: ModelClient = {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.system.includes('簇命名器')) {
      const lines = request.user.split('\n').slice(1).filter(Boolean);
      const names = lines.map((line) => {
        const parsed = JSON.parse(line) as { key: string };
        return { key: parsed.key, label: `主题${parsed.key.slice(0, 4)}` };
      });
      return { text: JSON.stringify({ names }), usage: { promptTokens: 12, completionTokens: 8 }, latencyMs: 3 };
    }
    return { text: JSON.stringify({ ops: [{ op: 'SKIP' }] }), usage: { promptTokens: 0, completionTokens: 0 }, latencyMs: 0 };
  },
};

function stamp(turn: number): string {
  return new Date(Date.UTC(2026, 10, 20, 9, 0, 0) + turn * 60_000).toISOString();
}

const TYPES: NodeType[] = ['claim', 'ai-voice', 'fact', 'question', 'shift'];

async function buildReplay(): Promise<{ nodes: number; edges: number; turns: number; shiftTurn: number }> {
  const storage = new FsStorage(REPLAY_SESSION, home);
  const graph = new ThoughtGraph(REPLAY_SESSION, storage);
  let previousInPhase: string | null = null;
  let created = 0;
  let shiftTurn = 0;
  const turnCount = 60;
  for (let turn = 1; turn <= turnCount; turn++) {
    const phase = Math.floor((turn - 1) / 6);
    if ((turn - 1) % 6 === 0) previousInPhase = null;
    const ops: MapOp[] = [];
    for (let k = 0; k < 5; k++) {
      const type = TYPES[k];
      const labelPrefix = type === 'ai-voice' ? 'AI观点' : type === 'fact' ? '事实' : type === 'question' ? '问题' : type === 'shift' ? '转变' : '论点';
      const label = `${labelPrefix}-${phase + 1}-${(turn - 1) % 6}${k}`;
      const op: MapOp = {
        op: 'ADD_NODE',
        node: { type, label, summary: `合成第 ${phase + 1} 大陆节点 ${label}：用于 D4 回放与大陆轮廓验收。` },
      };
      if (previousInPhase) {
        (op as Extract<MapOp, { op: 'ADD_NODE' }>).edges = [
          { from: previousInPhase, to: '@new', kind: 'related', bornTurn: turn },
        ];
      }
      ops.push(op);
      created++;
      previousInPhase = `n_${String(created).padStart(4, '0')}`;
      if (type === 'shift' && shiftTurn === 0) shiftTurn = turn;
    }
    const result = await graph.applyTurn(turn, ops, stamp(turn));
    if (!result.ok) throw new Error(`seed turn ${turn} failed: ${result.reason}`);
    await storage.appendTurn({
      sessionId: REPLAY_SESSION,
      turnIndex: turn,
      userText: `合成第 ${turn} 轮用户原话：我在梳理第 ${Math.floor((turn - 1) / 6) + 1} 个主题大陆。`,
      assistantText: `合成第 ${turn} 轮助手回答：已把本轮讨论挂到对应主题大陆上。`,
      timestamp: stamp(turn),
      source: 'sandbox',
    });
  }

  const map = graph.getMap();
  const aiVoices = map.nodes.filter((node) => node.type === 'ai-voice').map((node) => node.id);
  const shifts = map.nodes.filter((node) => node.type === 'shift').map((node) => node.id);
  if (aiVoices.length === 0 || shifts.length === 0) throw new Error('fixture missing ai-voice or shift nodes');
  let pair = 0;
  let turn = turnCount + 1;
  while (graph.getMap().edges.length < 600) {
    const ops: MapOp[] = [];
    for (let k = 0; k < 5 && graph.getMap().edges.length + ops.length < 600; k++) {
      const from = aiVoices[pair % aiVoices.length];
      const to = shifts[Math.floor(pair / aiVoices.length) % shifts.length];
      pair++;
      if (from === to) continue;
      ops.push({ op: 'ADD_EDGE', edge: { from, to, kind: 'influence', bornTurn: turn } });
    }
    if (ops.length === 0) throw new Error('fixture could not add influence edges');
    const result = await graph.applyTurn(turn, ops, stamp(turn));
    if (!result.ok) throw new Error(`seed edge turn ${turn} failed: ${result.reason}`);
    await storage.appendTurn({
      sessionId: REPLAY_SESSION,
      turnIndex: turn,
      userText: `合成第 ${turn} 轮补充链路：核对观点影响关系。`,
      assistantText: `合成第 ${turn} 轮助手回答：已补充影响边。`,
      timestamp: stamp(turn),
      source: 'sandbox',
    });
    turn++;
  }
  const finalMap = graph.getMap();
  return { nodes: finalMap.nodes.length, edges: finalMap.edges.length, turns: finalMap.lastTurn, shiftTurn };
}

async function buildXss(): Promise<void> {
  const storage = new FsStorage(XSS_SESSION, home);
  const graph = new ThoughtGraph(XSS_SESSION, storage);
  const payloads = [
    { label: '<script>window.__xssFired=1</script>', summary: '<img src=x onerror="window.__xssFired=2">' },
    { label: '<img src=x onerror=window.__xssFired=3>', summary: '<svg onload=window.__xssFired=4></svg>' },
    { label: '"><iframe srcdoc="<script>parent.__xssFired=5</script>">', summary: 'javascript:alert(document.domain)' },
  ];
  const ops: MapOp[] = payloads.map((payload) => ({
    op: 'ADD_NODE',
    node: { type: 'claim', label: payload.label, summary: payload.summary },
  }));
  const result = await graph.applyTurn(1, ops, stamp(1));
  if (!result.ok) throw new Error(`seed xss failed: ${result.reason}`);
  return storage.appendTurn({
    sessionId: XSS_SESSION,
    turnIndex: 1,
    userText: '<img src=x onerror="window.__xssFired=6">合成用户原文',
    assistantText: '<script>window.__xssFired=7</script>合成助手原文',
    timestamp: stamp(1),
    source: 'sandbox',
  });
}

async function buildManual(): Promise<{ nodes: number; edges: number }> {
  const storage = new FsStorage(MANUAL_SESSION, home);
  const graph = new ThoughtGraph(MANUAL_SESSION, storage);
  const turns: MapOp[][] = [
    [
      { op: 'ADD_NODE', node: { type: 'claim', label: '旧观点甲', summary: '合成手动操作会话：旧观点甲。' } },
      { op: 'ADD_NODE', node: { type: 'ai-voice', label: 'AI提醒', summary: '合成 AI 观点，不可标记为转变。' } },
      { op: 'ADD_NODE', node: { type: 'claim', label: '旧观点乙', summary: '合成手动操作会话：旧观点乙。' } },
    ],
    [
      { op: 'REINFORCE', nodeId: 'n_0001', turn: 2 },
      { op: 'ADD_NODE', node: { type: 'question', label: '追问丙', summary: '合成追问节点。' } },
    ],
    [{ op: 'ADD_NODE', node: { type: 'fact', label: '事实丁', summary: '合成事实节点。' } }],
  ];
  for (let index = 0; index < turns.length; index++) {
    const turn = index + 1;
    const result = await graph.applyTurn(turn, turns[index], stamp(turn));
    if (!result.ok) throw new Error(`seed manual turn ${turn} failed: ${result.reason}`);
    await storage.appendTurn({
      sessionId: MANUAL_SESSION,
      turnIndex: turn,
      userText: `合成手动操作会话第 ${turn} 轮用户原话。`,
      assistantText: `合成手动操作会话第 ${turn} 轮助手回答。`,
      timestamp: stamp(turn),
      source: 'sandbox',
    });
  }
  const map = graph.getMap();
  return { nodes: map.nodes.length, edges: map.edges.length };
}

async function main(): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  for (const session of [REPLAY_SESSION, XSS_SESSION, MANUAL_SESSION]) {
    await rm(join(home, 'sessions', session), { recursive: true, force: true });
  }
  const replay = await buildReplay();
  await buildXss();
  const manual = await buildManual();

  const daemon = new AtlasDaemon({
    model: stubModel,
    home,
    port,
    storageFactory: (id) => new FsStorage(id, home),
    webDir,
  });
  const actualPort = await daemon.start();
  const summary = {
    home,
    port: actualPort,
    webDir,
    sessions: [
      { sessionId: REPLAY_SESSION, nodes: replay.nodes, edges: replay.edges, turns: replay.turns, firstShiftTurn: replay.shiftTurn },
      { sessionId: XSS_SESSION, nodes: 3, edges: 0, turns: 1 },
      { sessionId: MANUAL_SESSION, nodes: manual.nodes, edges: manual.edges, turns: 3 },
    ],
  };
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/d4-fixture.json', JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`d4 fixtures ready on http://127.0.0.1:${actualPort}`);

  const shutdown = (): void => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();