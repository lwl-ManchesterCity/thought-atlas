import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelClient, ModelRequest, ModelResponse } from '@thought-atlas/core';
import { AtlasDaemon, DeepSeekClient, FsStorage, loadConfig } from '@thought-atlas/daemon';

const SESSION = 'd4-replay-300';
const home = process.env.ATLAS_D4_HOME ?? join(homedir(), '.thought-atlas-d4');

interface ClusterViewItem {
  key: string;
  index: number;
  label: string;
  named: boolean;
  nodeIds: string[];
}

interface ClusterView {
  sessionId: string;
  activeCount: number;
  clusters: ClusterViewItem[];
  isolated: string[];
}

const config = await loadConfig();
const client = new DeepSeekClient(config);
const usage: { promptTokens: number; completionTokens: number }[] = [];
const metered: ModelClient = {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await client.complete(request);
    usage.push(response.usage);
    return response;
  },
};

const daemon = new AtlasDaemon({
  model: metered,
  home,
  port: 0,
  storageFactory: (id) => new FsStorage(id, home),
});
const port = await daemon.start();
const base = `http://127.0.0.1:${port}`;

const before = (await (await fetch(`${base}/clusters?sessionId=${SESSION}`)).json()) as ClusterView;
const started = Date.now();
const res = await fetch(`${base}/clusters/refresh`, {
  method: 'POST',
  body: JSON.stringify({ sessionId: SESSION }),
});
const after = (await res.json()) as ClusterView;
const latencyMs = Date.now() - started;
await daemon.stop();

const named = after.clusters.filter((cluster) => cluster.named);
const evidence = {
  date: new Date().toISOString(),
  method: '合成会话 d4-replay-300 → 临时 AtlasDaemon（port 0）+ 真实 DeepSeekClient → POST /clusters/refresh',
  model: config.model,
  thinking: config.model.startsWith('deepseek') ? 'disabled' : 'default',
  sessionId: SESSION,
  activeCount: after.activeCount,
  beforeNamed: before.clusters.filter((cluster) => cluster.named).length,
  clusters: after.clusters.map((cluster) => ({
    index: cluster.index,
    key: cluster.key,
    label: cluster.label,
    named: cluster.named,
    nodes: cluster.nodeIds.length,
  })),
  isolated: after.isolated.length,
  namedCount: named.length,
  usage: usage.reduce(
    (acc, item) => ({ promptTokens: acc.promptTokens + item.promptTokens, completionTokens: acc.completionTokens + item.completionTokens }),
    { promptTokens: 0, completionTokens: 0 },
  ),
  latencyMs,
  httpStatus: res.status,
  pass: res.ok && named.length === after.clusters.length && after.clusters.length > 0,
};

await mkdir('evidence', { recursive: true });
await writeFile('evidence/d4-clusters.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));