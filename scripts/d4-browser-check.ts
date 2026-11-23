import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.ATLAS_D4_CDP_PORT ?? 9335);
const BASE = process.env.ATLAS_D4_BASE ?? 'http://127.0.0.1:7803';
const SHOTS = 'evidence/d4-screenshots';
const REPLAY_SESSION = 'd4-replay-300';
const MANUAL_SESSION = 'd4-manual-3';
const XSS_SESSION = 'd4-anchor-xss';

type Json = Record<string, unknown>;

interface TimelineState {
  index: number;
  total: number;
  playing: boolean;
  speed: number;
  mode: string;
  pendingLive: boolean;
  label: string;
}

interface Stats {
  fps: number;
  frames: number;
  nodes: number;
  edges: number;
  converged: boolean;
  zoom: number;
  focused: boolean;
  selected: string | null;
  tier: string;
  clusters: number;
  namedClusters: number;
  pulsing: number;
  searchMatches: number;
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

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function launch(): Promise<{ chrome: ChildProcess; wsUrl: string; profile: string }> {
  const profile = `/tmp/atlas-d4-chrome-${Date.now()}`;
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

async function navigate(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
}

async function waitReady(cdp: Cdp, session: string, timeoutMs = 15000): Promise<number> {
  const start = Date.now();
  let diag: unknown = null;
  while (Date.now() - start < timeoutMs) {
    const ok = await cdp.eval<boolean>(
      `(() => { const a = window.__atlas; if (!a || window.__atlasReadyAt === undefined) return false; const s = a.stats(); return a.session() === ${JSON.stringify(session)} && s.nodes > 0; })()`,
    );
    if (ok) return Date.now() - start;
    await sleep(100);
    if (Date.now() - start > 4000 && diag === null) {
      diag = await cdp.eval(
        `({ ready: document.readyState, url: location.href, atlas: typeof window.__atlas, readyAt: window.__atlasReadyAt ?? null, stats: window.__atlas ? window.__atlas.stats() : null, text: (document.body?.innerText ?? '').slice(0, 200) })`,
      );
      console.log('diagnostics:', JSON.stringify(diag));
      console.log('consoleErrors:', JSON.stringify(cdp.consoleErrors));
    }
  }
  throw new Error(`page never became ready: ${JSON.stringify(diag)}`);
}

async function waitFor(cdp: Cdp, expression: string, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cdp.eval<boolean>(`(() => (${expression}))()`)) return;
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${label}`);
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
  await sleep(200);
}

const evidence: Json = { runAt: new Date().toISOString(), chrome: 'headless=new', base: BASE };
await mkdir(SHOTS, { recursive: true });
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
  await navigate(cdp, `${BASE}/?session=${REPLAY_SESSION}`);
  const waitMs = await waitReady(cdp, REPLAY_SESSION);
  const coldWallMs = Date.now() - coldStart;
  const cold = await cdp.eval<{ readyAt: number; domEnd: number; loadEnd: number; stats: Stats }>(
    `(() => { const nav = performance.getEntriesByType('navigation')[0]; return { readyAt: Math.round(window.__atlasReadyAt), domEnd: Math.round(nav.domContentLoadedEventEnd), loadEnd: Math.round(nav.loadEventEnd), stats: window.__atlas.stats() }; })()`,
  );
  check(coldWallMs < 3000, `cold open ${coldWallMs}ms must be < 3000ms`);
  check(cold.stats.nodes === 300 && cold.stats.edges === 600, 'cold map must be 300 nodes / 600 edges');
  evidence.coldOpen = { coldWallMs, waitMs, ...cold };
  let timeline = await cdp.eval<TimelineState>('window.__atlas.timeline()');
  check(timeline.total === 122 && timeline.mode === 'live' && timeline.index === 122, 'timeline starts at live end');
  evidence.timelineInitial = timeline;
  await cdp.eval('window.__atlas.fit()');
  await waitFor(cdp, 'window.__atlas.stats().converged', 'layout converged', 15000);

  await cdp.eval(`document.querySelector('#cluster-refresh').click()`);
  await waitFor(cdp, 'window.__atlas.stats().namedClusters >= 10', 'cluster naming', 10000);
  const labels = await cdp.eval<Record<string, string>>('window.__atlas.labels()');
  const labelValues = Object.values(labels);
  check(labelValues.length >= 10, `expected >=10 named clusters, got ${labelValues.length}`);
  check(labelValues.every((label) => [...label].length <= 8), 'cluster labels must be <= 8 chars');
  const namedStats = await cdp.eval<Stats>('window.__atlas.stats()');
  check(namedStats.clusters >= 10 && namedStats.namedClusters >= 10, 'stats must report named clusters');
  evidence.clusters = { labels, stats: namedStats };

  await cdp.eval('window.__atlas.setZoom(0.4)');
  await sleep(400);
  const farStats = await cdp.eval<Stats>('window.__atlas.stats()');
  check(farStats.tier === 'far', `zoom 0.4 tier = ${farStats.tier}`);
  const farShot = await screenshot(cdp, 'lod-far-continents');

  await cdp.eval('window.__atlas.setZoom(0.75)');
  await sleep(300);
  const midStats = await cdp.eval<Stats>('window.__atlas.stats()');
  check(midStats.tier === 'mid', `zoom 0.75 tier = ${midStats.tier}`);
  const midShot = await screenshot(cdp, 'lod-mid-dots');

  await cdp.eval('window.__atlas.setZoom(1.2)');
  await sleep(300);
  const nearStats = await cdp.eval<Stats>('window.__atlas.stats()');
  check(nearStats.tier === 'near', `zoom 1.2 tier = ${nearStats.tier}`);
  const nearShot = await screenshot(cdp, 'lod-near-labels');
  evidence.lod = { farStats, midStats, nearStats, farShot, midShot, nearShot };

  await cdp.eval('window.__atlas.seek(0)');
  const emptyState = await cdp.eval<{ nodes: number; edges: number; timeline: TimelineState }>(
    '({ nodes: window.__atlas.stats().nodes, edges: window.__atlas.stats().edges, timeline: window.__atlas.timeline() })',
  );
  check(emptyState.nodes === 0 && emptyState.timeline.mode === 'replay' && emptyState.timeline.index === 0, 'seek(0) should show replay start');

  await cdp.eval('window.__atlas.seek(1)');
  const pulse = await cdp.eval<{ stats: Stats; map: { nodes: { id: string; type: string }[] } }>(
    '({ stats: window.__atlas.stats(), map: window.__atlas.map() })',
  );
  check(pulse.map.nodes.length === 5, 'turn 1 should have 5 nodes');
  check(pulse.map.nodes.some((node) => node.type === 'shift'), 'turn 1 should contain a shift node');
  check(pulse.stats.pulsing >= 1, `shift pulse expected, pulsing=${pulse.stats.pulsing}`);
  const pulseShot = await screenshot(cdp, 'replay-shift-pulse');
  evidence.shiftPulse = { ...pulse, pulseShot };

  await cdp.eval(
    `(() => { const el = document.querySelector('#replay-range'); el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
  await sleep(350);
  const drag30 = await cdp.eval<{ nodes: number; edges: number; timeline: TimelineState; map: { lastTurn: number } }>(
    '({ nodes: window.__atlas.stats().nodes, edges: window.__atlas.stats().edges, timeline: window.__atlas.timeline(), map: window.__atlas.map() })',
  );
  check(drag30.nodes === 150 && drag30.edges === 145, `turn 30 expected 150/145, got ${drag30.nodes}/${drag30.edges}`);
  check(drag30.timeline.index === 30 && drag30.timeline.mode === 'replay', 'range drag should seek to step 30');
  check(drag30.map.lastTurn === 30, `fold lastTurn ${drag30.map.lastTurn} !== 30`);

  await cdp.eval(
    `(() => { const el = document.querySelector('#replay-range'); el.value = '60'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
  await sleep(350);
  const drag60 = await cdp.eval<{ nodes: number; edges: number }>(
    '({ nodes: window.__atlas.stats().nodes, edges: window.__atlas.stats().edges })',
  );
  check(drag60.nodes === 300 && drag60.edges === 290, `turn 60 expected 300/290, got ${drag60.nodes}/${drag60.edges}`);
  evidence.drag = { drag30, drag60 };

  await cdp.eval(
    `(() => { const sel = document.querySelector('#replay-speed'); sel.value = '3'; sel.dispatchEvent(new Event('change', { bubbles: true })); window.__atlas.seek(0); document.querySelector('#replay-toggle').click(); return true; })()`,
  );
  await sleep(950);
  const play1 = await cdp.eval<TimelineState>('window.__atlas.timeline()');
  await sleep(700);
  const play2 = await cdp.eval<TimelineState>('window.__atlas.timeline()');
  check(play1.playing && play2.playing, 'playback should be playing');
  check(play1.speed === 3, `speed expected 3, got ${play1.speed}`);
  check(play1.index >= 2 && play2.index > play1.index, `playback should advance: ${play1.index} -> ${play2.index}`);
  await cdp.eval(`document.querySelector('#replay-toggle').click()`);
  const paused = await cdp.eval<TimelineState>('window.__atlas.timeline()');
  check(!paused.playing, 'pause should stop playback');
  evidence.playback = { play1, play2, paused };

  await cdp.eval('window.__atlas.seek(122)');
  const endState = await cdp.eval<{ nodes: number; edges: number; timeline: TimelineState }>(
    '({ nodes: window.__atlas.stats().nodes, edges: window.__atlas.stats().edges, timeline: window.__atlas.timeline() })',
  );
  check(endState.nodes === 300 && endState.edges === 600, 'replay end should be 300/600');
  check(endState.timeline.index === 122, 'replay end index 122');
  await cdp.eval('window.__atlas.fit()');
  await waitFor(cdp, 'window.__atlas.stats().converged', 'replay end converged', 15000);
  const replayShot = await screenshot(cdp, 'replay-end-300-600');
  evidence.replayEnd = { ...endState, replayShot };

  await cdp.eval(
    `(() => { const el = document.querySelector('#search'); el.value = '论点-4'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
  await sleep(500);
  const search = await cdp.eval<{
    stats: Stats;
    ids: string[];
    first: string;
    screen: { x: number; y: number } | null;
    center: { x: number; y: number };
  }>(
    `(() => {
      const m = window.__atlas.map();
      const ids = m.nodes.filter((n) => (n.label + n.summary).toLowerCase().includes('论点-4')).map((n) => n.id);
      const first = ids[0];
      const canvas = document.querySelector('#map').getBoundingClientRect();
      return { stats: window.__atlas.stats(), ids, first, screen: window.__atlas.nodeScreen(first), center: { x: canvas.width / 2, y: canvas.height / 2 } };
    })()`,
  );
  check(search.stats.searchMatches === search.ids.length, `search matches ${search.stats.searchMatches} !== ${search.ids.length}`);
  check(search.ids.length > 0 && search.screen !== null, 'search must match nodes');
  const dx = Math.abs((search.screen?.x ?? 0) - search.center.x);
  const dy = Math.abs((search.screen?.y ?? 0) - search.center.y);
  check(dx < 80 && dy < 80, `search centering off by ${dx}/${dy}`);
  const searchShot = await screenshot(cdp, 'search-centered');
  evidence.search = { ...search, dx, dy, searchShot };

  await cdp.eval(
    `(() => { const el = document.querySelector('#search'); el.value = '论点-1-00'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
  await sleep(500);
  await clickNode(cdp, 'n_0001');
  await waitFor(cdp, `document.querySelector('.anchor-list') && document.querySelector('.anchor-list').textContent.length > 10`, 'anchor panel text', 8000);
  const anchor = await cdp.eval<{
    title: string;
    text: string;
    turns: number;
    images: number;
    iframes: number;
    hasMarkup: boolean;
  }>(
    `(() => {
      const panel = document.querySelector('#panel');
      return {
        title: document.querySelector('.panel-title')?.textContent ?? '',
        text: panel.textContent ?? '',
        turns: panel.querySelectorAll('.anchor-turn').length,
        images: document.images.length,
        iframes: document.querySelectorAll('iframe').length,
        hasMarkup: panel.innerHTML.includes('<img') || panel.innerHTML.includes('<script') || panel.innerHTML.includes('<iframe'),
      };
    })()`,
  );
  check(anchor.title === '论点-1-00', `anchor title ${anchor.title}`);
  check(anchor.text.includes('合成第 1 轮用户原话') && anchor.text.includes('合成第 1 轮助手回答'), 'anchor must show local synthetic turn text');
  check(anchor.turns === 1, `anchor turn count ${anchor.turns}`);
  check(anchor.images === 0 && anchor.iframes === 0 && !anchor.hasMarkup, 'anchor panel must be inert');
  const anchorShot = await screenshot(cdp, 'anchor-panel-synthetic');
  evidence.anchorPanel = { ...anchor, anchorShot };

  await cdp.eval(`(() => { const el = document.querySelector('#search'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  await navigate(cdp, `${BASE}/?session=${XSS_SESSION}`);
  await waitReady(cdp, XSS_SESSION);
  await waitFor(cdp, 'window.__atlas.stats().converged', 'xss converged', 10000);
  await cdp.eval('window.__atlas.fit()');
  await cdp.eval(`window.__atlas.focus('n_0001')`);
  await waitFor(cdp, `document.querySelector('.anchor-list') && document.querySelector('.anchor-list').textContent.length > 10`, 'xss anchor text', 8000);
  const xss = await cdp.eval<{
    fired: unknown;
    images: number;
    scripts: number;
    iframes: number;
    panelText: string;
    hasMarkup: boolean;
  }>(
    `(() => {
      const panel = document.querySelector('#panel');
      return {
        fired: window.__xssFired ?? null,
        images: document.images.length,
        scripts: document.querySelectorAll('script').length,
        iframes: document.querySelectorAll('iframe').length,
        panelText: panel.textContent ?? '',
        hasMarkup: panel.innerHTML.includes('<img') || panel.innerHTML.includes('<script') || panel.innerHTML.includes('<iframe'),
      };
    })()`,
  );
  check(xss.fired === null, 'xss payload must not execute');
  check(xss.images === 0 && xss.iframes === 0 && !xss.hasMarkup, 'xss payload must stay inert text');
  check(xss.panelText.includes('<img src=x onerror="window.__xssFired=6">'), 'anchor text should display markup literally');
  const xssShot = await screenshot(cdp, 'anchor-xss-inert');
  evidence.xss = { ...xss, xssShot };

  await navigate(cdp, `${BASE}/?session=${MANUAL_SESSION}`);
  await waitReady(cdp, MANUAL_SESSION);
  await waitFor(cdp, 'window.__atlas.stats().converged', 'manual converged', 10000);
  await cdp.eval('window.__atlas.fit()');
  const manualBefore = await cdp.eval<TimelineState>('window.__atlas.timeline()');
  await cdp.eval(`window.__atlas.focus('n_0001')`);
  await waitFor(cdp, '!document.querySelector("#panel").hidden', 'panel visible', 5000);
  await cdp.eval(`document.querySelectorAll('.panel-action')[0].click()`);
  await waitFor(
    cdp,
    `window.__atlas.map().nodes.find((n) => n.id === 'n_0001')?.type === 'shift' && window.__atlas.timeline().total === ${manualBefore.total + 1}`,
    'manual mark-shift applied',
    8000,
  );
  const marked = await cdp.eval<{ timeline: TimelineState; type: string; manual: boolean; panelText: string }>(
    `(() => { const node = window.__atlas.map().nodes.find((n) => n.id === 'n_0001'); return { timeline: window.__atlas.timeline(), type: node.type, manual: node.manual, panelText: document.querySelector('#panel').textContent ?? '' }; })()`,
  );
  check(marked.type === 'shift' && marked.manual === true, 'manual mark-shift should set shift + manual');
  const markShot = await screenshot(cdp, 'manual-mark-shift');

  await cdp.eval(`window.__atlas.focus('n_0003')`);
  await waitFor(cdp, '!document.querySelector("#panel").hidden', 'panel visible for delete', 5000);
  await cdp.eval(`document.querySelectorAll('.panel-action')[1].click()`);
  await waitFor(
    cdp,
    `!window.__atlas.map().nodes.some((n) => n.id === 'n_0003') && window.__atlas.timeline().total === ${manualBefore.total + 2}`,
    'manual delete applied',
    8000,
  );
  const deleted = await cdp.eval<{ timeline: TimelineState; hasNode: boolean; panelHidden: boolean }>(
    `({ timeline: window.__atlas.timeline(), hasNode: window.__atlas.map().nodes.some((n) => n.id === 'n_0003'), panelHidden: document.querySelector('#panel').hidden })`,
  );
  check(!deleted.hasNode && deleted.panelHidden, 'deleted node should disappear and panel close');

  await cdp.eval(`window.__atlas.seek(0)`);
  await cdp.eval(`window.__atlas.seek(${manualBefore.total + 2})`);
  const reflected = await cdp.eval<{ nodes: { id: string; type: string }[]; index: number; mode: string }>(
    `(() => { const m = window.__atlas.map(); return { nodes: m.nodes, index: window.__atlas.timeline().index, mode: window.__atlas.timeline().mode }; })()`,
  );
  const replayedShift = reflected.nodes.find((node) => node.id === 'n_0001');
  check(reflected.mode === 'replay', 'manual verification should run in replay mode');
  check(replayedShift?.type === 'shift', 'replay should reflect manual mark-shift');
  check(!reflected.nodes.some((node) => node.id === 'n_0003'), 'replay should reflect manual delete');
  await waitFor(cdp, 'window.__atlas.stats().converged', 'manual replay converged', 10000);
  const replayManualShot = await screenshot(cdp, 'manual-replay-reflected');
  evidence.manual = { manualBefore, marked, deleted, reflectedCount: reflected.nodes.length, markShot, replayManualShot };

  await navigate(cdp, `${BASE}/?session=${REPLAY_SESSION}`);
  await waitReady(cdp, REPLAY_SESSION);
  await cdp.eval('window.__atlas.seek(122)');
  await cdp.eval('window.__atlas.fit()');
  await waitFor(cdp, 'window.__atlas.stats().converged', 'perf converged', 15000);
  await cdp.eval('window.__atlas.setZoom(1.0)');
  await sleep(200);
  const fpsSamples: { fps: number; frames: number; tier: string }[] = [];
  for (let i = 0; i < 3; i++) {
    fpsSamples.push(
      await cdp.eval<{ fps: number; frames: number; tier: string }>(
        `(async () => { window.__atlas.pulse(0.9); await new Promise((r) => setTimeout(r, 1200)); const s = window.__atlas.stats(); return { fps: s.fps, frames: s.frames, tier: s.tier }; })()`,
      ),
    );
  }
  const sorted = fpsSamples.map((sample) => sample.fps).sort((a, b) => a - b);
  check(sorted[1] >= 50, `replay fps median ${sorted[1]} must be >= 50`);
  const perfShot = await screenshot(cdp, 'perf-replay-300-600');
  evidence.fps = {
    samples: fpsSamples,
    min: sorted[0],
    median: sorted[1],
    tier: fpsSamples[0].tier,
    note: 'headless Chrome (SwiftShader) 回放末态 300 节点/600 边，近景档 rAF 实测',
    perfShot,
  };

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await navigate(cdp, `${BASE}/?session=${REPLAY_SESSION}`);
  await waitReady(cdp, REPLAY_SESSION);
  await cdp.eval('window.__atlas.seek(122)');
  await cdp.eval('window.__atlas.fit()');
  await waitFor(cdp, 'window.__atlas.stats().converged', 'mobile converged', 15000);
  const mobile390 = await cdp.eval<{ innerWidth: number; scrollWidth: number; overflow: boolean; timelineBottom: number; timelineWidth: number }>(
    `(() => { const t = document.querySelector('.timeline').getBoundingClientRect(); return { innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, timelineBottom: t.bottom, timelineWidth: t.width }; })()`,
  );
  check(!mobile390.overflow, '390px layout must not overflow');
  const mobile390Shot = await screenshot(cdp, 'mobile-390-replay');
  await cdp.eval(`window.__atlas.focus('n_0001')`);
  await waitFor(cdp, '!document.querySelector("#panel").hidden', 'mobile panel visible', 5000);
  const mobilePanel = await cdp.eval<{ width: number; bottom: number; innerWidth: number; innerHeight: number }>(
    `(() => { const p = document.querySelector('#panel').getBoundingClientRect(); return { width: p.width, bottom: p.bottom, innerWidth: window.innerWidth, innerHeight: window.innerHeight }; })()`,
  );
  check(mobilePanel.width <= mobilePanel.innerWidth + 1 && mobilePanel.bottom <= mobilePanel.innerHeight + 1, 'mobile panel must fit viewport');
  const mobilePanelShot = await screenshot(cdp, 'mobile-390-panel');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 2, mobile: true });
  await navigate(cdp, `${BASE}/?session=${REPLAY_SESSION}`);
  await waitReady(cdp, REPLAY_SESSION);
  await cdp.eval('window.__atlas.seek(122)');
  await waitFor(cdp, 'window.__atlas.stats().nodes === 300', '320 nodes', 10000);
  const mobile320 = await cdp.eval<{ innerWidth: number; scrollWidth: number; overflow: boolean; timelineVisible: boolean }>(
    `(() => { const t = document.querySelector('.timeline').getBoundingClientRect(); return { innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, timelineVisible: t.width > 0 && t.height > 0 }; })()`,
  );
  check(!mobile320.overflow, '320px layout must not overflow');
  check(mobile320.timelineVisible, '320px timeline must stay visible');
  const mobile320Shot = await screenshot(cdp, 'mobile-320');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  evidence.mobile = { mobile390, mobile390Shot, mobilePanel, mobilePanelShot, mobile320, mobile320Shot };

  await navigate(cdp, `${BASE}/?session=${REPLAY_SESSION}`);
  await waitReady(cdp, REPLAY_SESSION);
  evidence.consoleErrors = cdp.consoleErrors;
  evidence.pageErrors = cdp.pageErrors;
  check(cdp.consoleErrors.length === 0, `console errors: ${JSON.stringify(cdp.consoleErrors)}`);
  check(cdp.pageErrors.length === 0, `page errors: ${JSON.stringify(cdp.pageErrors)}`);

  await writeFile('evidence/d4-browser.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} catch (err) {
  evidence.error = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  evidence.consoleErrors = cdp.consoleErrors;
  evidence.pageErrors = cdp.pageErrors;
  await writeFile('evidence/d4-browser.json', JSON.stringify(evidence, null, 2) + '\n');
  throw err;
} finally {
  cdp.close();
  chrome.kill('SIGTERM');
  await rm(profile, { force: true, recursive: true }).catch(() => undefined);
}