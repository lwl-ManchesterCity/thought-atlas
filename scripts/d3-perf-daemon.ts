import { mkdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GraphMap,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ThoughtEdge,
  ThoughtNode,
  NodeType,
} from '@thought-atlas/core';
import { AtlasDaemon, FsStorage } from '@thought-atlas/daemon';

const PERF_SESSION = 'perf-synthetic-300';
const XSS_SESSION = 'xss-fixture';

const home = process.env.ATLAS_PERF_HOME ?? join(homedir(), '.thought-atlas-perf');
const port = Number(process.env.ATLAS_PERF_PORT ?? 7802);
const webDir = process.env.ATLAS_WEB_DIR ?? fileURLToPath(new URL('../packages/web/dist', import.meta.url));

const stubModel: ModelClient = {
  async complete(_request: ModelRequest): Promise<ModelResponse> {
    return {
      text: JSON.stringify({ ops: [{ op: 'SKIP' }] }),
      usage: { promptTokens: 0, completionTokens: 0 },
      latencyMs: 0,
    };
  },
};

function nodeById(nodes: ThoughtNode[], id: string): ThoughtNode | undefined {
  return nodes.find((n) => n.id === id);
}

function buildPerfMap(): GraphMap {
  const types: NodeType[] = ['claim', 'claim', 'question', 'fact', 'ai-voice', 'ai-voice', 'shift'];
  const prefixes: Record<NodeType, string> = {
    claim: '观点',
    question: '问题',
    fact: '事实',
    'ai-voice': 'AI看法',
    shift: '转变',
  };
  const nodes: ThoughtNode[] = [];
  for (let i = 1; i <= 300; i++) {
    const type = types[i % types.length];
    const rings: number[] = [];
    const ringCount = 1 + (i % 5);
    for (let r = 0; r < ringCount; r++) rings.push(Math.max(1, (i * 3 + r * 7) % 120));
    rings.sort((a, b) => a - b);
    const id = `n_${String(i).padStart(4, '0')}`;
    const superseded = i % 23 === 0;
    const merged = i % 29 === 0;
    const node: ThoughtNode = {
      id,
      type,
      owner: type === 'ai-voice' ? 'ai' : 'user',
      label: `${prefixes[type]}-${String(i).padStart(3, '0')}`,
      summary: `合成压测节点 ${i}，用于验证 300 节点规模下的布局与渲染性能。`,
      bornTurn: 1 + (i % 40),
      lastTurn: 1 + ((i * 2) % 40),
      rings,
      status: superseded ? 'superseded' : merged ? 'merged' : 'active',
      supersededBy: superseded ? `n_${String(Math.min(300, i + 1)).padStart(4, '0')}` : null,
      mergedInto: merged ? `n_${String(Math.max(1, i - 1)).padStart(4, '0')}` : null,
      anchorTurns: rings,
      clusterId: null,
      manual: false,
    };
    if (type === 'shift') {
      node.shift = {
        fromNodeId: i > 2 ? `n_${String(i - 2).padStart(4, '0')}` : null,
        toSummary: `转变后的认识 ${i}`,
        triggerNodeId: i > 3 ? `n_${String(i - 3).padStart(4, '0')}` : null,
        triggerTurn: node.bornTurn,
      };
    }
    nodes.push(node);
  }

  const edges: ThoughtEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: ThoughtEdge['kind']): void => {
    const key = `${from}>${to}:${kind}`;
    if (from === to || seen.has(key) || !nodeById(nodes, from) || !nodeById(nodes, to)) return;
    seen.add(key);
    edges.push({ from, to, kind, bornTurn: 1 });
  };

  for (let i = 2; i <= 300; i++) {
    add(`n_${String(Math.floor(i / 2)).padStart(4, '0')}`, `n_${String(i).padStart(4, '0')}`, 'related');
  }
  for (let i = 1; edges.length < 600 && i <= 300; i++) {
    const from = `n_${String(i).padStart(4, '0')}`;
    const node = nodeById(nodes, from)!;
    if (node.status === 'superseded') {
      add(from, node.supersededBy ?? '', 'supersede');
    } else if (i % 3 === 0) {
      const target = `n_${String(1 + ((i * 37) % 300)).padStart(4, '0')}`;
      add(from, target, i % 6 === 0 ? 'influence' : 'related');
    }
  }
  for (let i = 1; edges.length < 600 && i <= 300; i++) {
    const from = `n_${String(i).padStart(4, '0')}`;
    const target = `n_${String(1 + ((i * 53 + 11) % 300)).padStart(4, '0')}`;
    add(from, target, 'influence');
  }

  return { sessionId: PERF_SESSION, nodes, edges, lastTurn: 40 };
}

function buildXssMap(): GraphMap {
  const payloads: { label: string; summary: string }[] = [
    {
      label: '<script>window.__xssFired=1</script>',
      summary: '<img src=x onerror="window.__xssFired=1">',
    },
    {
      label: '<img src=x onerror=window.__xssFired=2>',
      summary: '<svg onload=window.__xssFired=3></svg>',
    },
    {
      label: '"><iframe srcdoc="<script>parent.__xssFired=4</script>">',
      summary: 'javascript:alert(document.domain)',
    },
    {
      label: '<b onmouseover=window.__xssFired=5>hover</b>',
      summary: '</textarea><script>window.__xssFired=6</script>',
    },
    {
      label: '&lt;script&gt;escape-test&lt;/script&gt;',
      summary: '文本实体应当按字面显示，不产生节点。',
    },
  ];
  const nodes: ThoughtNode[] = payloads.map((p, idx) => ({
    id: `x_${String(idx + 1).padStart(4, '0')}`,
    type: idx === 4 ? 'ai-voice' : 'claim',
    owner: idx === 4 ? 'ai' : 'user',
    label: p.label,
    summary: p.summary,
    bornTurn: 1,
    lastTurn: 1,
    rings: [1],
    status: 'active',
    supersededBy: null,
    mergedInto: null,
    anchorTurns: [1],
    clusterId: null,
    manual: false,
  }));
  const edges: ThoughtEdge[] = [
    { from: 'x_0001', to: 'x_0002', kind: 'influence', bornTurn: 1 },
    { from: 'x_0002', to: 'x_0003', kind: 'related', bornTurn: 1 },
    { from: 'x_0003', to: 'x_0004', kind: 'related', bornTurn: 1 },
    { from: 'x_0004', to: 'x_0005', kind: 'influence', bornTurn: 1 },
  ];
  return { sessionId: XSS_SESSION, nodes, edges, lastTurn: 2 };
}

await mkdir(home, { recursive: true, mode: 0o700 });
await chmod(home, 0o700);

const perfStorage = new FsStorage(PERF_SESSION, home);
await perfStorage.saveMap(buildPerfMap());
const xssStorage = new FsStorage(XSS_SESSION, home);
await xssStorage.saveMap(buildXssMap());

const daemon = new AtlasDaemon({
  model: stubModel,
  home,
  port,
  storageFactory: (id) => new FsStorage(id, home),
  webDir,
});
const actualPort = await daemon.start();
console.log(`perf fixtures ready: ${PERF_SESSION} (300 nodes/600 edges), ${XSS_SESSION} (5 nodes)`);
console.log(`perf daemon listening on http://127.0.0.1:${actualPort} (webDir=${webDir})`);

const shutdown = (): void => {
  void daemon.stop().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);