import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelClient, ModelRequest, ModelResponse } from '@thought-atlas/core';
import { AtlasDaemon, FsStorage } from '@thought-atlas/daemon';
import { postTurn } from '@thought-atlas/adapter-watcher';
import { QoderWatcher } from '@thought-atlas/adapter-qoder';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9341;
const SESSION = 'qoder-synth-live';
const WEB_DIR = fileURLToPath(new URL('../packages/web/dist', import.meta.url));
const EVIDENCE = fileURLToPath(new URL('../evidence/d5-latency.json', import.meta.url));
const SHOTS = fileURLToPath(new URL('../evidence/d5-screenshots', import.meta.url));

type Json = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
}

const stubModel: ModelClient = {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.system.includes('簇命名器')) {
      const lines = request.user.split('\n').slice(1).filter(Boolean);
      const names = lines.map((line) => {
        const parsed = JSON.parse(line) as { key: string };
        return { key: parsed.key, label: `合成主题-${parsed.key.slice(0, 4)}` };
      });
      return { text: JSON.stringify({ names }), usage: { promptTokens: 8, completionTokens: 4 }, latencyMs: 2 };
    }
    const turn = Number(/当前轮次:\s*(\d+)/.exec(request.user)?.[1] ?? 1);
    return {
      text: JSON.stringify({
        ops: [
          {
            op: 'ADD_NODE',
            node: { type: 'fact', label: `合成实时节点${turn}`, summary: `合成实时轮 ${turn} 触发的新事实` },
          },
        ],
      }),
      usage: { promptTokens: 10, completionTokens: 6 },
      latencyMs: 5,
    };
  },
};

function turnRecords(turn: number, assistantId: string): Json[] {
  const timestamp = new Date(Date.UTC(2026, 10, 23, 6, turn, 0)).toISOString();
  return [
    {
      type: 'user',
      uuid: `synth-human-${turn}`,
      timestamp,
      isSidechain: false,
      origin: { kind: 'human' },
      humanInput: { text: `合成第 ${turn} 轮实时用户发言，用于测量端到端延迟。` },
      message: { role: 'user', content: [{ type: 'text', text: `合成第 ${turn} 轮实时用户发言，用于测量端到端延迟。` }] },
    },
    {
      type: 'assistant',
      uuid: assistantId,
      timestamp,
      isSidechain: false,
      responseGroupId: assistantId,
      message: {
        id: assistantId,
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: `合成第 ${turn} 轮最终回答：已记录一条合成事实。` }],
      },
    },
  ];
}

function lines(records: Json[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  consoleErrors: string[] = [];
  pageErrors: string[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Json;
        result?: Json;
        error?: { message: string };
      };
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result ?? {});
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const params = msg.params as { type: string; args: { value?: unknown; description?: string }[] };
        if (params.type === 'error') {
          this.consoleErrors.push(params.args.map((a) => String(a.value ?? a.description ?? '')).join(' '));
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const params = msg.params as { exceptionDetails: { text: string; exception?: { description?: string } } };
        this.pageErrors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
      }
    });
  }

  send(method: string, params: Json = {}): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
    });
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const result = (await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as unknown as {
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      throw new Error(`eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function launchChrome(): Promise<{ chrome: ChildProcess; wsUrl: string; profile: string }> {
  const profile = await mkdtemp(join(tmpdir(), 'atlas-d5-chrome-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,800',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let version: { webSocketDebuggerUrl?: string } | null = null;
  for (let i = 0; i < 60; i++) {
    try {
      version = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!version) throw new Error('chrome debug endpoint unavailable');
  const targets = await fetchJson<{ type: string; webSocketDebuggerUrl: string }[]>(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('no page target');
  return { chrome, wsUrl: page.webSocketDebuggerUrl, profile };
}

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  return new Cdp(ws);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'atlas-d5-latency-'));
  const home = join(root, 'home');
  const watchDir = join(root, 'transcript');
  const transcript = join(watchDir, 'synth-live.jsonl');
  let chrome: ChildProcess | null = null;
  let chromeProfile: string | null = null;
  let cdp: Cdp | null = null;
  let watcher: QoderWatcher | null = null;
  let daemon: AtlasDaemon | null = null;
  const started = Date.now();
  try {
    await mkdir(home, { recursive: true });
    await mkdir(watchDir, { recursive: true });
    await mkdir(SHOTS, { recursive: true });
    await writeFile(transcript, lines(turnRecords(1, 'msg-synth-1')));

    daemon = new AtlasDaemon({
      model: stubModel,
      home,
      port: 0,
      storageFactory: (sessionId) => new FsStorage(sessionId, home),
      webDir: WEB_DIR,
    });
    const port = await daemon.start();
    const base = `http://127.0.0.1:${port}`;

    watcher = new QoderWatcher({
      targets: [transcript],
      cursorDir: join(root, 'cursors'),
      pollIntervalMs: 250,
      deliver: (payload) => postTurn(base, payload, 20_000),
    });
    await watcher.start();

    let initialSteps = 0;
    for (let i = 0; i < 100; i++) {
      const replay = await fetchJson<{ steps: unknown[] }>(`${base}/replay?sessionId=${SESSION}`);
      initialSteps = replay.steps.length;
      if (initialSteps >= 1) break;
      await sleep(50);
    }
    check(initialSteps === 1, `initial backfill steps=${initialSteps}`);

    const launched = await launchChrome();
    chrome = launched.chrome;
    chromeProfile = launched.profile;
    cdp = await connect(launched.wsUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: `${base}/?session=${SESSION}` });

    let ready = false;
    for (let i = 0; i < 200; i++) {
      ready = await cdp.eval<boolean>('typeof window.__atlas !== "undefined" && !!window.__atlasReadyAt');
      if (ready) break;
      await sleep(50);
    }
    check(ready, 'web app not ready');

    let beforeNodes = 0;
    for (let i = 0; i < 100; i++) {
      beforeNodes = await cdp.eval<number>('window.__atlas.map()?.nodes.length ?? 0');
      if (beforeNodes >= 1) break;
      await sleep(50);
    }
    check(beforeNodes >= 1, `browser initial nodes=${beforeNodes}`);

    const t0 = Date.now();
    await writeFile(transcript, lines([...turnRecords(1, 'msg-synth-1'), ...turnRecords(2, 'msg-synth-2')]));

    let uiNodes = beforeNodes;
    let lastTurn = 0;
    while (Date.now() - t0 <= 8000) {
      uiNodes = await cdp.eval<number>('window.__atlas.map()?.nodes.length ?? 0');
      lastTurn = await cdp.eval<number>('window.__atlas.map()?.lastTurn ?? 0');
      if (uiNodes > beforeNodes && lastTurn >= 2) break;
      await sleep(50);
    }
    const latencyMs = Date.now() - t0;
    check(uiNodes > beforeNodes, `ui nodes did not grow: ${uiNodes}`);
    check(lastTurn >= 2, `ui lastTurn=${lastTurn}`);
    check(latencyMs <= 8000, `latency ${latencyMs}ms > 8000ms`);

    const screenshot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data?: string };
    if (screenshot.data) {
      await writeFile(join(SHOTS, 'd5-latency-after.png'), Buffer.from(screenshot.data, 'base64'));
    }

    const evidence = {
      synthetic: true,
      session: SESSION,
      pollIntervalMs: 250,
      modelStub: { latencyMs: 5, ops: 'ADD_NODE' },
      initialSteps,
      initialNodes: beforeNodes,
      finalNodes: uiNodes,
      finalTurn: lastTurn,
      latencyMs,
      within8s: latencyMs <= 8000,
      consoleErrors: cdp.consoleErrors,
      pageErrors: cdp.pageErrors,
      elapsedMs: Date.now() - started,
    };
    await writeFile(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  } finally {
    cdp?.close();
    watcher?.stop();
    if (chrome && chrome.exitCode === null) {
      chrome.kill('SIGKILL');
      await Promise.race([once(chrome, 'exit'), sleep(1000)]);
    }
    await Promise.race([daemon?.stop() ?? Promise.resolve(), sleep(2000)]);
    if (chromeProfile) await rm(chromeProfile, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
process.exit(0);