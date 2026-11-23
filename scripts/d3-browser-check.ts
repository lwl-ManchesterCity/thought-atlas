import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.ATLAS_CDP_PORT ?? 9333);
const PERF_BASE = process.env.ATLAS_PERF_BASE ?? 'http://127.0.0.1:7802';
const LIVE_BASE = process.env.ATLAS_LIVE_BASE ?? 'http://127.0.0.1:7788';
const SHOTS = 'evidence/d3-screenshots';

type Json = Record<string, unknown>;

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((params: Json) => void)[]>();
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
      if (msg.method) {
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
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
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

  once(method: string, timeoutMs = 15000): Promise<Json> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`event timeout: ${method}`)), timeoutMs);
      const handler = (params: Json): void => {
        clearTimeout(timer);
        const list = this.listeners.get(method) ?? [];
        this.listeners.set(
          method,
          list.filter((fn) => fn !== handler),
        );
        resolve(params);
      };
      const list = this.listeners.get(method) ?? [];
      list.push(handler);
      this.listeners.set(method, list);
    });
  }

  async eval<T = unknown>(expression: string, awaitPromise = true): Promise<T> {
    const result = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    })) as unknown as {
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

async function launch(): Promise<{ chrome: ChildProcess; wsUrl: string; profile: string }> {
  const profile = `/tmp/atlas-d3-chrome-${Date.now()}`;
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
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!version) throw new Error('chrome debug endpoint unavailable');
  const targets = await fetchJson<{ type: string; webSocketDebuggerUrl: string }[]>(
    `http://127.0.0.1:${DEBUG_PORT}/json/list`,
  );
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  chrome.on('exit', () => undefined);
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

async function navigate(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
}

async function waitReady(cdp: Cdp, session?: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  let diag: unknown = null;
  while (Date.now() - start < timeoutMs) {
    const ok = await cdp.eval<boolean>(
      `(() => { const a = window.__atlas; if (!a || window.__atlasReadyAt === undefined) return false; const s = a.stats(); return ${session ? `a.session() === ${JSON.stringify(session)} &&` : ''} s.nodes > 0; })()`,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 120));
    if (Date.now() - start > 4000 && diag === null) {
      diag = await cdp.eval(
        `({ ready: document.readyState, url: location.href, atlas: typeof window.__atlas, readyAt: window.__atlasReadyAt ?? null, stats: window.__atlas ? window.__atlas.stats() : null, err: window.__atlasErr ?? null, text: (document.body?.innerText ?? '').slice(0, 200) })`,
      );
      console.log('diagnostics:', JSON.stringify(diag));
      console.log('consoleErrors:', JSON.stringify(cdp.consoleErrors));
      console.log('pageErrors:', JSON.stringify(cdp.pageErrors));
    }
  }
  throw new Error(`page never became ready: ${JSON.stringify(diag)}`);
}

async function waitConverged(cdp: Cdp, timeoutMs = 12000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cdp.eval<boolean>('window.__atlas.stats().converged')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('layout never converged');
}

async function screenshot(cdp: Cdp, name: string): Promise<string> {
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as unknown as { data: string };
  const path = join(SHOTS, `${name}.png`);
  await writeFile(path, Buffer.from(shot.data, 'base64'));
  return path;
}

async function clickNode(cdp: Cdp, nodeId: string): Promise<void> {
  const point = await cdp.eval<{ x: number; y: number } | null>(
    `(() => { const p = window.__atlas.nodeScreen(${JSON.stringify(nodeId)}); if (!p) return null; const r = document.querySelector('#map').getBoundingClientRect(); return { x: p.x + r.left, y: p.y + r.top }; })()`,
  );
  if (!point) throw new Error(`node not found: ${nodeId}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: 'left',
      clickCount: 1,
    });
  }
  await new Promise((r) => setTimeout(r, 250));
}

async function clickBlank(cdp: Cdp): Promise<void> {
  const point = await cdp.eval<{ x: number; y: number }>(
    `(() => { const r = document.querySelector('#map').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height - 40 }; })()`,
  );
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
  }
  await new Promise((r) => setTimeout(r, 200));
}

async function postTurn(base: string, sessionId: string, turnIndex: number, userText: string, assistantText: string): Promise<void> {
  const res = await fetch(`${base}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      turnIndex,
      userText,
      assistantText,
      timestamp: new Date().toISOString(),
      source: 'sandbox',
    }),
  });
  if (!res.ok) throw new Error(`POST /turn -> ${res.status}`);
  const body = (await res.json()) as { status?: string };
  if (body.status !== 'applied' && body.status !== 'skipped') throw new Error(`unexpected ingest status: ${JSON.stringify(body)}`);
}

const evidence: Json = { runAt: new Date().toISOString(), chrome: 'headless=new', perfBase: PERF_BASE, liveBase: LIVE_BASE };
await mkdir(SHOTS, { recursive: true });

const { chrome, wsUrl, profile } = await launch();
const cdp = await connect(wsUrl);
try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.addEventListener("error", (e) => { window.__atlasErr = String(e.message || e.error); }); window.addEventListener("unhandledrejection", (e) => { window.__atlasErr = String(e.reason); });',
  });

  await navigate(cdp, `${PERF_BASE}/?session=perf-synthetic-300`);
  await waitReady(cdp, 'perf-synthetic-300');
  const cold = await cdp.eval<{ readyAt: number; domEnd: number; loadEnd: number; stats: Json }>(
    `(() => { const nav = performance.getEntriesByType('navigation')[0]; return { readyAt: Math.round(window.__atlasReadyAt), domEnd: Math.round(nav.domContentLoadedEventEnd), loadEnd: Math.round(nav.loadEventEnd), stats: window.__atlas.stats() }; })()`,
  );
  evidence.coldOpen = cold;

  await cdp.eval('window.__atlas.fit()');
  await screenshot(cdp, 'perf-300-nodes');

  const fpsSamples: { fps: number; frames: number }[] = [];
  for (let i = 0; i < 3; i++) {
    fpsSamples.push(
      await cdp.eval<{ fps: number; frames: number }>(
        `(async () => { window.__atlas.pulse(0.9); await new Promise(r => setTimeout(r, 1200)); const s = window.__atlas.stats(); return { fps: s.fps, frames: s.frames, converged: s.converged }; })()`,
      ),
    );
  }
  const sorted = fpsSamples.map((s) => s.fps).sort((a, b) => a - b);
  evidence.fps = {
    samples: fpsSamples,
    min: sorted[0],
    median: sorted[1],
    note: 'headless Chrome (SwiftShader) 下 300 节点/600 边，rAF 实测；多窗口取样',
  };

  const beforeClick = await cdp.eval<{ focused: boolean; panelHidden: boolean }>(
    `({ focused: window.__atlas.stats().focused, panelHidden: document.querySelector('#panel').hidden })`,
  );
  await clickNode(cdp, 'n_0002');
  const afterClick = await cdp.eval<{
    focused: boolean;
    selected: string | null;
    panelHidden: boolean;
    panelTitle: string;
    panelSummary: string;
  }>(
    `({ focused: window.__atlas.stats().focused, selected: window.__atlas.stats().selected, panelHidden: document.querySelector('#panel').hidden, panelTitle: document.querySelector('.panel-title')?.textContent ?? '', panelSummary: document.querySelector('.panel-summary')?.textContent ?? '' })`,
  );
  const focusShot = await screenshot(cdp, 'perf-focus-mode');

  await clickBlank(cdp);
  const afterBlank = await cdp.eval<{ focused: boolean; panelHidden: boolean }>(
    `({ focused: window.__atlas.stats().focused, panelHidden: document.querySelector('#panel').hidden })`,
  );
  evidence.focusMode = { beforeClick, afterClick, afterBlank, focusShot };

  await navigate(cdp, `${PERF_BASE}/?session=xss-fixture`);
  await waitReady(cdp, 'xss-fixture');
  await waitConverged(cdp);
  await clickNode(cdp, 'x_0001');
  const xss = await cdp.eval<{
    fired: unknown;
    images: number;
    scripts: number;
    iframes: number;
    title: string;
    summary: string;
    panelHtmlContainsImgTag: boolean;
  }>(
    `(() => {
      const panel = document.querySelector('#panel');
      return {
        fired: window.__xssFired ?? null,
        images: document.images.length,
        scripts: document.querySelectorAll('script').length,
        iframes: document.querySelectorAll('iframe').length,
        title: document.querySelector('.panel-title')?.textContent ?? '',
        summary: document.querySelector('.panel-summary')?.textContent ?? '',
        panelHtmlContainsImgTag: (panel.innerHTML.includes('<img') || panel.innerHTML.includes('<script')),
      };
    })()`,
  );
  const xssShot = await screenshot(cdp, 'xss-fixture-inert');
  evidence.xss = { ...xss, xssShot };

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await navigate(cdp, `${PERF_BASE}/?session=perf-synthetic-300`);
  await waitReady(cdp, 'perf-synthetic-300');
  const mobile = await cdp.eval<{ innerWidth: number; scrollWidth: number; overflow: boolean; topbarWidth: number }>(
    `({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, topbarWidth: document.querySelector('.topbar').getBoundingClientRect().width })`,
  );
  const mobileShot = await screenshot(cdp, 'mobile-390');
  await waitConverged(cdp);
  await clickNode(cdp, 'n_0002');
  const mobilePanel = await cdp.eval<{ hidden: boolean; width: number; bottom: number; innerHeight: number }>(
    `(() => { const p = document.querySelector('#panel'); const r = p.getBoundingClientRect(); return { hidden: p.hidden, width: r.width, bottom: r.bottom, innerHeight: window.innerHeight }; })()`,
  );
  const mobilePanelShot = await screenshot(cdp, 'mobile-390-panel');
  evidence.mobile = { ...mobile, mobileShot, mobilePanel, mobilePanelShot };
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  const liveSession = `d3-live-${Date.now()}`;
  await postTurn(
    LIVE_BASE,
    liveSession,
    1,
    '今天重新理解了一下浮点误差：0.1 加 0.2 在 JavaScript 里不等于 0.3，我一直以为这是语言的 bug。',
    '这是 IEEE754 双精度表示的舍入结果，所有遵循 IEEE754 的语言都会得到同样的结果。',
  );
  await navigate(cdp, `${LIVE_BASE}/?session=${liveSession}`);
  await waitReady(cdp, liveSession);
  const liveCold = await cdp.eval<{ readyAt: number; nodes: number; lastTurn: number; map: { nodes: { id: string; bornTurn: number }[] } }>(
    `({ readyAt: Math.round(window.__atlasReadyAt), nodes: window.__atlas.stats().nodes, lastTurn: window.__atlas.map().lastTurn, map: window.__atlas.map() })`,
  );
  const beforeNodes = liveCold.nodes;
  const postStarted = Date.now();
  await postTurn(
    LIVE_BASE,
    liveSession,
    2,
    '原来如此，那这不是实现错误，而是有限精度下的必然取舍；同一段逻辑在 Python 和 Java 里结果也一样。',
    '对，这是表示法的共同约束，不是 JavaScript 的缺陷。',
  );
  const postDone = Date.now();
  let visibleMs = -1;
  let sawAnimating = false;
  for (let i = 0; i < 80; i++) {
    const state = await cdp.eval<{ nodes: number; converged: boolean }>(
      `({ nodes: window.__atlas.stats().nodes, converged: window.__atlas.stats().converged })`,
    );
    if (!state.converged) sawAnimating = true;
    if (state.nodes > beforeNodes) {
      visibleMs = Date.now() - postDone;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await waitConverged(cdp);
  const newest = await cdp.eval<{ id: string } | null>(
    `(() => { const m = window.__atlas.map(); const n = m.nodes[m.nodes.length - 1]; return n ? { id: n.id } : null; })()`,
  );
  if (newest) await clickNode(cdp, newest.id);
  const liveShot = await screenshot(cdp, 'live-growth');
  evidence.liveGrowth = {
    sessionId: liveSession,
    readyAt: liveCold.readyAt,
    beforeNodes,
    visibleMs,
    postRoundTripMs: postDone - postStarted,
    sawAnimating,
    nodesAfter: await cdp.eval('window.__atlas.stats().nodes'),
    shot: liveShot,
  };

  await navigate(cdp, `${PERF_BASE}/?session=perf-synthetic-300`);
  await waitReady(cdp, 'perf-synthetic-300');
  evidence.consoleErrors = cdp.consoleErrors;
  evidence.pageErrors = cdp.pageErrors;

  await writeFile('evidence/d3-browser.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  cdp.close();
  chrome.kill('SIGTERM');
  await rm(profile, { force: true, recursive: true }).catch(() => undefined);
}