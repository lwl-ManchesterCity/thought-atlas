import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.ATLAS_D6_CDP_PORT ?? 9337);
const BASE = process.env.ATLAS_D6_BASE ?? 'http://127.0.0.1:7790';
const SHOTS = 'evidence/d6-screenshots';
const MARKER = 'D6-原文标记-7f3a9c';
const XSS = '<img src=x onerror="window.__xss=true"><b>粗体</b>';

type Json = Record<string, unknown>;

interface SiteTurn {
  turnIndex: number;
  status: string;
  nodes: number;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function launch(): Promise<{ chrome: ChildProcess; wsUrl: string; profile: string }> {
  const profile = `/tmp/atlas-d6-chrome-${Date.now()}`;
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

async function navigate(cdp: Cdp, url: string): Promise<number> {
  const started = Date.now();
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  return Date.now() - started;
}

async function waitFor(cdp: Cdp, expression: string, label: string, timeoutMs = 12000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await cdp.eval<boolean>(`(() => (${expression}))()`)) return;
    await sleep(80);
  }
  const diag = await cdp.eval(
    '({ url: location.href, ready: document.readyState, diag: window.__atlasSite ?? null, body: (document.body?.innerText ?? "").slice(0, 300) })',
  );
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(diag)}`);
}

async function waitDashboard(cdp: Cdp, file: string): Promise<number> {
  const started = Date.now();
  await waitFor(
    cdp,
    `window.__atlasSite?.ready === true && window.__atlasSite.nodes() > 0 && location.search.includes(${JSON.stringify(file)})`,
    `dashboard ${file}`,
  );
  return Date.now() - started;
}

async function screenshot(cdp: Cdp, name: string): Promise<string> {
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as unknown as { data: string };
  const path = join(SHOTS, `${name}.png`);
  await writeFile(path, Buffer.from(shot.data, 'base64'));
  return path;
}

async function fullScreenshot(cdp: Cdp, name: string, width = 1280): Promise<{ path: string; height: number }> {
  const metrics = (await cdp.send('Page.getLayoutMetrics')) as unknown as { cssContentSize: { width: number; height: number } };
  const height = Math.min(Math.round(metrics.cssContentSize.height), 3000);
  const shot = (await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  })) as unknown as { data: string };
  const path = join(SHOTS, `${name}.png`);
  await writeFile(path, Buffer.from(shot.data, 'base64'));
  return { path, height };
}

async function submit(cdp: Cdp, value: string): Promise<void> {
  await cdp.eval(
    `(() => { const el = document.querySelector('#message'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); return true; })()`,
  );
}

async function overflow(cdp: Cdp): Promise<{ width: number; scrollWidth: number; overflow: boolean }> {
  return cdp.eval<{ width: number; scrollWidth: number; overflow: boolean }>(
    '({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 })',
  );
}

const evidence: Json = { runAt: new Date().toISOString(), base: BASE, chrome: 'headless=new', screenshots: SHOTS };
await mkdir(SHOTS, { recursive: true });

await fetch(`${BASE}/__dev/reset`, { method: 'POST' });

const { chrome, wsUrl, profile } = await launch();
const cdp = await connect(wsUrl);

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      'window.addEventListener("error", (e) => { window.__atlasErr = String(e.message || e.error); }); window.addEventListener("unhandledrejection", (e) => { window.__atlasErr = String(e.reason); });',
  });

  const coldStart = Date.now();
  const navMs = await navigate(cdp, `${BASE}/demo.html?session=focus`);
  const readyMs = await waitDashboard(cdp, 'focus');
  await waitFor(cdp, 'window.__atlasSite.settled() === true', 'demo layout settle', 15000);
  await cdp.eval('window.__atlasSite.fit()');
  await sleep(150);
  const coldWallMs = Date.now() - coldStart;
  const perf = await cdp.eval<{ readyAt: number; domEnd: number; loadEnd: number }>(
    `(() => { const nav = performance.getEntriesByType('navigation')[0]; return { readyAt: Math.round(window.__atlasReadyAt), domEnd: Math.round(nav.domContentLoadedEventEnd), loadEnd: Math.round(nav.loadEventEnd) }; })()`,
  );
  check(coldWallMs < 3000, `cold open ${coldWallMs}ms must be < 3000ms`);
  const focusState = await cdp.eval<{ title: string; nodes: number; shifts: number; label: string; stats: string; banner: string; tabs: number }>(
    `({ title: document.querySelector('#sample-title')?.textContent ?? '', nodes: window.__atlasSite.nodes(), shifts: window.__atlasSite.shifts(), label: document.querySelector('#turn-label')?.textContent ?? '', stats: document.querySelector('#turn-stats')?.textContent ?? '', banner: document.querySelector('#banner')?.textContent ?? '', tabs: document.querySelectorAll('.session-tab').length })`,
  );
  check(focusState.nodes === 9 && focusState.shifts === 1, `focus map expected 9/1, got ${focusState.nodes}/${focusState.shifts}`);
  check(focusState.tabs === 2, `expected 2 sample tabs, got ${focusState.tabs}`);
  check(focusState.banner.includes('合成演示数据'), 'sample banner must label synthetic data');

  await cdp.eval(`(() => { const el = document.querySelector('#range'); el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(cdp, 'window.__atlasSite.nodes() === 0', 'replay zero');
  const zeroLabel = await cdp.eval<string>(`document.querySelector('#turn-label')?.textContent ?? ''`);
  check(zeroLabel.includes('起点'), `zero turn label: ${zeroLabel}`);
  await cdp.eval(`(() => { const el = document.querySelector('#range'); el.value = '10'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(cdp, 'window.__atlasSite.nodes() === 9', 'replay end');
  await waitFor(cdp, 'window.__atlasSite.settled() === true', 'replay settle', 15000);
  await cdp.eval('window.__atlasSite.fit()');
  await sleep(150);
  check(await cdp.eval<boolean>('document.querySelector("#panel").hidden'), 'panel should stay closed until selection');

  const selected = await cdp.eval<boolean>('window.__atlasSite.selectFirstShift()');
  check(selected, 'first shift node should exist');
  await waitFor(cdp, 'window.__atlasSite.panelVisible() === true', 'shift panel');
  const shiftPanel = await cdp.eval<{ text: string; images: number; markup: boolean; title: string }>(
    `(() => { const p = document.querySelector('#panel'); return { text: p.textContent ?? '', images: p.querySelectorAll('img,iframe,script').length, markup: /<(img|script|iframe)/i.test(p.innerHTML), title: document.querySelector('.panel-title')?.textContent ?? '' }; })()`,
  );
  check(shiftPanel.text.includes('锚点原文') && shiftPanel.text.includes('转变立场'), 'shift panel must show anchor text and shift note');
  check(shiftPanel.images === 0 && !shiftPanel.markup, 'panel must render text only');
  await cdp.eval('window.scrollTo(0, 0)');
  await sleep(120);
  const demoShot = await screenshot(cdp, 'demo-focus-desktop');

  await cdp.eval(`document.querySelector('.session-tab[data-file="learning.json"]').click()`);
  await waitDashboard(cdp, 'learning');
  await waitFor(cdp, 'window.__atlasSite.settled() === true', 'learning settle', 15000);
  await cdp.eval('window.__atlasSite.fit()');
  await sleep(150);
  const learningState = await cdp.eval<{ nodes: number; shifts: number; stats: string }>(
    `({ nodes: window.__atlasSite.nodes(), shifts: window.__atlasSite.shifts(), stats: document.querySelector('#turn-stats')?.textContent ?? '' })`,
  );
  check(learningState.nodes === 8 && learningState.shifts === 1, `learning map expected 8/1, got ${learningState.nodes}/${learningState.shifts}`);
  const learningShot = await screenshot(cdp, 'demo-learning-desktop');
  evidence.demo = { navMs, readyMs, coldWallMs, perf, focusState, shiftPanel, learningState, demoShot, learningShot };

  const pages: Record<string, string> = {
    home: '/',
    demo: '/demo.html',
    sandbox: '/sandbox.html',
    install: '/install.html',
    boundary: '/boundary.html',
  };
  const pageChecks: Record<string, { title: string; marker: string; ms: number }> = {};
  for (const [name, path] of Object.entries(pages)) {
    const ms = await navigate(cdp, `${BASE}${path}`);
    const info = await cdp.eval<{ title: string; marker: string; h1: string }>(
      `({ title: document.title, marker: (document.body?.innerText ?? '').slice(0, 120), h1: document.querySelector('h1')?.textContent ?? '' })`,
    );
    check(info.title.length > 0 && info.marker.length > 20, `${name} page must render content`);
    pageChecks[name] = { title: info.title, marker: info.h1, ms };
  }
  const boundaryText = await cdp.eval<string>('document.body.innerText');
  check(boundaryText.includes('原文不留存'), 'boundary page must state no original text retention');
  check(boundaryText.includes('最多 2 次'), 'boundary page must state session limits');
  check(boundaryText.includes('100 轮'), 'boundary page must state analysis limits');
  evidence.pages = pageChecks;

  await cdp.eval('sessionStorage.clear()');
  await navigate(cdp, `${BASE}/sandbox.html`);
  await waitFor(cdp, 'window.__atlasSite?.ready === true', 'sandbox ready');
  const health = await fetchJson<{ ok: boolean; configured: boolean; model: string; stub?: boolean }>(`${BASE}/functions/v1/app/api/health`);
  check(health.ok && health.configured && typeof health.model === 'string' && health.model.length > 0, 'health must report a configured model label');
  const stubMode = health.stub === true;

  const turns: SiteTurn[] = [];
  for (let i = 1; i <= 2; i++) {
    const text = i === 1
      ? `${MARKER} 我在想 JavaScript 里 0.1 + 0.2 为什么不等于 0.3，这算是语言的 bug 吗？`
      : '那银行算钱为什么不用浮点数，而是用整数分或者 decimal 库？这两种做法的取舍是什么？';
    await submit(cdp, text);
    const ready = stubMode
      ? `window.__atlasSite.nodes() === ${i} && window.__atlasSite.status().includes('第 ${i} 轮')`
      : `window.__atlasSite.status().includes('第 ${i} 轮')`;
    await waitFor(cdp, ready, `sandbox turn ${i}`, 30000);
    turns.push(
      await cdp.eval<SiteTurn>(
        `({ turnIndex: ${i}, status: window.__atlasSite.status(), nodes: window.__atlasSite.nodes() })`,
      ),
    );
  }
  const sessionId = await cdp.eval<string | null>('window.__atlasSite.session()');
  check(typeof sessionId === 'string' && sessionId.length === 36, `sandbox session id ${sessionId}`);
  if (!stubMode) {
    const grown = await cdp.eval<number>('window.__atlasSite.nodes()');
    check(grown >= 1, `real model should grow at least one node, got ${grown}`);
  }
  await waitFor(cdp, 'window.__atlasSite.settled() === true', 'sandbox settle', 15000);
  await cdp.eval('window.__atlasSite.fit()');
  await sleep(150);

  await submit(cdp, XSS);
  const thirdReady = stubMode
    ? `window.__atlasSite.nodes() === 3 && window.__atlasSite.status().includes('第 3 轮')`
    : `window.__atlasSite.status().includes('第 3 轮')`;
  await waitFor(cdp, thirdReady, 'sandbox turn 3', 30000);
  const xssState = await cdp.eval<{ fired: unknown; images: number; markupNodes: number; literal: boolean; status: string; limits: string }>(
    `(() => { const log = document.querySelector('#chat-log'); return { fired: window.__xss, images: document.querySelectorAll('img').length, markupNodes: document.querySelectorAll('#chat-log img, #chat-log b, #chat-log script').length, literal: (log.innerText ?? '').includes('<img src=x onerror='), status: window.__atlasSite.status(), limits: document.querySelector('#limits')?.textContent ?? '' }; })()`,
  );
  check(xssState.fired === undefined, 'xss payload must not execute');
  check(xssState.images === 0 && xssState.markupNodes === 0 && xssState.literal, 'xss payload must render as literal text');
  check(xssState.limits.includes('97 / 100'), `daily analyses remaining: ${xssState.limits}`);

  const focused = await cdp.eval<boolean>('window.__atlasSite.focusFirstNode()');
  check(focused, 'sandbox first node should exist');
  await waitFor(cdp, 'document.querySelector("#panel").hidden === false && (document.querySelector("#panel").textContent ?? "").includes("锚点原文")', 'sandbox panel');
  const sandboxPanel = await cdp.eval<{ text: string; markup: boolean }>(
    `(() => { const p = document.querySelector('#panel'); return { text: p.textContent ?? '', markup: /<(img|script|iframe)/i.test(p.innerHTML) }; })()`,
  );
  check(sandboxPanel.text.includes(MARKER), 'sandbox panel should show in-page turn text');
  check(!sandboxPanel.markup, 'sandbox panel must render text only');
  await cdp.eval('window.scrollTo(0, 0)');
  await sleep(120);
  const sandboxShot = await screenshot(cdp, 'sandbox-3turns-desktop');
  const sandboxFull = await fullScreenshot(cdp, 'sandbox-3turns-full');

  const state = await fetchJson<{ tables: Record<string, Json[]> }>(`${BASE}/__dev/state`);
  const serialized = JSON.stringify(state);
  check(!serialized.includes(MARKER), 'server database must not store original turn text');
  check(!serialized.includes('<img src=x'), 'server database must not store markup input');
  const turnRows = state.tables.sandbox_turns ?? [];
  check(turnRows.length === 3, `expected 3 turn rows, got ${turnRows.length}`);
  const hashesValid = turnRows.every(
    (row) => typeof row.input_hash === 'string' && /^[0-9a-f]{64}$/.test(row.input_hash) && typeof row.skeleton_hash === 'string' && /^[0-9a-f]{64}$/.test(row.skeleton_hash),
  );
  check(hashesValid, 'turn rows must contain only 64-hex hashes');
  const cacheRows = state.tables.analysis_cache ?? [];
  check(!JSON.stringify(cacheRows).includes(MARKER), 'analysis cache must not contain original text');
  const sessionRows = state.tables.sandbox_sessions ?? [];
  check(sessionRows.length === 1 && sessionRows[0].last_turn === 3, 'session counter must be 3');
  check(!serialized.includes('"text"'), 'no table may have a text column');
  evidence.sandbox = {
    health,
    sessionId,
    turns,
    xssState,
    panelHasMarker: sandboxPanel.text.includes(MARKER),
    db: { turnRows: turnRows.length, cacheRows: cacheRows.length, sessionRows: sessionRows.length, lastTurn: sessionRows[0]?.last_turn, hashesValid, originalTextStored: false },
    sandboxShot,
    sandboxFull,
  };

  const responsive: Record<string, unknown> = {};
  for (const width of [390, 320]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 640, deviceScaleFactor: 2, mobile: true });
    for (const [name, path] of Object.entries(pages)) {
      await navigate(cdp, `${BASE}${path}`);
      if (name === 'demo') await waitFor(cdp, 'window.__atlasSite?.ready === true && window.__atlasSite.nodes() > 0', 'mobile demo');
      else await sleep(150);
      const size = await overflow(cdp);
      check(!size.overflow, `${width}px ${name} must not overflow: ${size.scrollWidth} > ${size.width}`);
      (responsive)[`${name}-${width}`] = size;
      if (name === 'demo') {
        await waitFor(cdp, 'window.__atlasSite.settled() === true', 'mobile demo settle', 15000);
        await cdp.eval('window.__atlasSite.fit()');
      }
      if (name === 'demo' || name === 'home' || name === 'sandbox') {
        await cdp.eval('window.scrollTo(0, 0)');
        await sleep(100);
        (responsive)[`${name}Shot-${width}`] = await screenshot(cdp, `mobile-${width}-${name}`);
      }
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  evidence.responsive = responsive;

  await navigate(cdp, `${BASE}/`);
  evidence.consoleErrors = cdp.consoleErrors;
  evidence.pageErrors = cdp.pageErrors;
  check(cdp.consoleErrors.length === 0, `console errors: ${JSON.stringify(cdp.consoleErrors)}`);
  check(cdp.pageErrors.length === 0, `page errors: ${JSON.stringify(cdp.pageErrors)}`);

  await writeFile('evidence/d6-site.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} catch (err) {
  evidence.error = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  evidence.consoleErrors = cdp.consoleErrors;
  evidence.pageErrors = cdp.pageErrors;
  await writeFile('evidence/d6-site.json', JSON.stringify(evidence, null, 2) + '\n');
  throw err;
} finally {
  cdp.close();
  chrome.kill('SIGTERM');
  await rm(profile, { force: true, recursive: true }).catch(() => undefined);
}