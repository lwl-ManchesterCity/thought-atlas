import {
  foldEvents,
  type EventRecord,
  type GraphMap,
  type GraphUpdate,
  type ThoughtNode,
} from '@thought-atlas/core';
import { StarMapRenderer, type RendererStats } from './renderer.ts';
import { createPanel, type AnchorPayload, type ManualAction } from './panel.ts';

interface SessionInfo {
  sessionId: string;
  lastTurn: number;
  nodes: number;
  edges: number;
  updatedAt: string;
}

interface ReplayStep {
  turnIndex: number;
  timestamp: string;
  manual: boolean;
  opsCount: number;
}

interface ReplayPayload {
  sessionId: string;
  lastTurn: number;
  steps: ReplayStep[];
  events: EventRecord[];
}

interface ClusterViewItem {
  key: string;
  index: number;
  label: string;
  nodeIds: string[];
  size: number;
  named: boolean;
}

interface ClusterView {
  sessionId: string;
  activeCount: number;
  clusters: ClusterViewItem[];
  isolated: string[];
}

type Mode = 'live' | 'replay';

function must<T extends Element>(el: T | null, name: string): T {
  if (!el) throw new Error(`页面结构缺失: ${name}`);
  return el;
}

const canvas = must(document.querySelector<HTMLCanvasElement>('#map'), '#map');
const panelEl = must(document.querySelector<HTMLElement>('#panel'), '#panel');
const sessionSelect = must(document.querySelector<HTMLSelectElement>('#session'), '#session');
const statsEl = must(document.querySelector<HTMLElement>('#stats'), '#stats');
const stateEl = must(document.querySelector<HTMLElement>('#live-state'), '#live-state');
const searchEl = must(document.querySelector<HTMLInputElement>('#search'), '#search');
const clusterBtn = must(document.querySelector<HTMLButtonElement>('#cluster-refresh'), '#cluster-refresh');
const timelineToggle = must(document.querySelector<HTMLButtonElement>('#replay-toggle'), '#replay-toggle');
const timelineRange = must(document.querySelector<HTMLInputElement>('#replay-range'), '#replay-range');
const timelineLabel = must(document.querySelector<HTMLElement>('#replay-label'), '#replay-label');
const timelineSpeed = must(document.querySelector<HTMLSelectElement>('#replay-speed'), '#replay-speed');
const liveBtn = must(document.querySelector<HTMLButtonElement>('#live-resume'), '#live-resume');
const emptyEl = document.querySelector<HTMLElement>('#empty-hint');

const panel = createPanel(panelEl, {
  onClose: () => renderer.clearFocus(),
  loadAnchors: async (nodeId: string) => {
    if (!currentSession) throw new Error('未选择会话');
    const res = await fetch(`/anchors?sessionId=${encodeURIComponent(currentSession)}&nodeId=${encodeURIComponent(nodeId)}`);
    if (!res.ok) throw new Error('锚点加载失败');
    return (await res.json()) as AnchorPayload;
  },
  onManual: (action: ManualAction, nodeId: string) => runManual(action, nodeId),
});

const renderer = new StarMapRenderer(canvas, {
  onSelect: (node: ThoughtNode | null) => (node ? panel.show(node) : panel.hide()),
  onStats: updateStats,
});

let currentSession: string | null = null;
let lastMap: GraphMap | null = null;
let source: EventSource | null = null;
let replay: ReplayPayload | null = null;
let replayIndex = 0;
let playing = false;
let playTimer = 0;
let speed = 1;
let mode: Mode = 'live';
let pendingLive = false;
let clusterLabels = new Map<string, string>();
let searchTimer = 0;
let replayMetaTimer = 0;
let clusterTimer = 0;

function updateStats(stats: RendererStats): void {
  const tierName = stats.tier === 'far' ? '远景' : stats.tier === 'mid' ? '中景' : '近景';
  const parts = [
    `${stats.nodes} 节点`,
    `${stats.edges} 连线`,
    `${tierName} · ${stats.converged ? '已稳定' : '布局中'}`,
    `${stats.fps} fps`,
  ];
  if (stats.searchMatches > 0) parts.push(`命中 ${stats.searchMatches}`);
  statsEl.textContent = parts.join(' · ');
}

function setState(text: string, live: boolean): void {
  stateEl.textContent = text;
  stateEl.dataset.live = live ? 'on' : 'off';
}

function tierLabel(): string {
  return mode === 'live' ? '实时' : '回放';
}

function updateTimeline(): void {
  const steps = replay?.steps ?? [];
  timelineRange.max = String(Math.max(0, steps.length));
  timelineRange.value = String(Math.max(0, Math.min(replayIndex, steps.length)));
  timelineRange.disabled = steps.length === 0;
  timelineToggle.disabled = steps.length === 0;
  timelineToggle.textContent = playing ? '暂停' : '播放';
  const step = steps[replayIndex - 1];
  const stepText = replayIndex === 0
    ? '起点'
    : step
      ? step.manual
        ? `手动操作 · ${step.opsCount} op`
        : `第 ${step.turnIndex} 轮 · ${step.opsCount} op`
      : '—';
  timelineLabel.textContent = `${tierLabel()} · ${stepText} · ${replayIndex}/${steps.length}`;
  liveBtn.dataset.active = mode === 'live' ? 'on' : 'off';
}

async function loadSessions(): Promise<SessionInfo[]> {
  const res = await fetch('/sessions');
  if (!res.ok) throw new Error('加载会话列表失败');
  return (await res.json()) as SessionInfo[];
}

async function fetchReplay(sessionId: string): Promise<ReplayPayload> {
  const res = await fetch(`/replay?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error('加载回放失败');
  return (await res.json()) as ReplayPayload;
}

async function fetchClusters(sessionId: string): Promise<ClusterView> {
  const res = await fetch(`/clusters?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error('加载簇失败');
  return (await res.json()) as ClusterView;
}

function applyClusters(view: ClusterView): void {
  clusterLabels = new Map(view.clusters.filter((cluster) => cluster.named).map((cluster) => [cluster.key, cluster.label]));
  renderer.setClusterLabels(clusterLabels);
}

function stopTimer(): void {
  if (playTimer) {
    window.clearInterval(playTimer);
    playTimer = 0;
  }
}

function pause(): void {
  if (!playing) return;
  playing = false;
  stopTimer();
  updateTimeline();
}

function seek(index: number, options: { pulse?: boolean } = {}): void {
  if (!replay || !currentSession) return;
  const target = Math.max(0, Math.min(replay.steps.length, Math.trunc(index)));
  const prev = lastMap;
  const prevIndex = replayIndex;
  mode = 'replay';
  replayIndex = target;
  const map = foldEvents(currentSession, replay.events.slice(0, target));
  lastMap = map;
  renderer.setMap(map, { animate: false });
  if (options.pulse !== false && target > prevIndex && prev) pulseNewShifts(prev, map);
  if (emptyEl) emptyEl.hidden = map.nodes.length > 0;
  applySearch(false);
  updateTimeline();
}

function pulseNewShifts(prev: GraphMap, next: GraphMap): void {
  const before = new Map(prev.nodes.map((node) => [node.id, node.type]));
  for (const node of next.nodes) {
    if (node.type === 'shift' && before.get(node.id) !== 'shift') renderer.pulseShift(node.id);
  }
}

function schedulePlayback(): void {
  stopTimer();
  if (!playing) return;
  playTimer = window.setInterval(() => {
    if (!replay) {
      pause();
      return;
    }
    if (replayIndex >= replay.steps.length) {
      pause();
      return;
    }
    seek(replayIndex + 1);
    if (replayIndex >= replay.steps.length) pause();
  }, 900 / speed);
}

function play(): void {
  if (!replay || replay.steps.length === 0) return;
  if (replayIndex >= replay.steps.length) {
    seek(0, { pulse: false });
  }
  mode = 'replay';
  playing = true;
  schedulePlayback();
  updateTimeline();
}

function applySearch(center: boolean): string[] {
  if (!lastMap) return [];
  const query = searchEl.value.trim().toLowerCase();
  if (!query) {
    renderer.setSearchMatches([]);
    return [];
  }
  const matches = lastMap.nodes.filter(
    (node) => node.label.toLowerCase().includes(query) || node.summary.toLowerCase().includes(query),
  );
  const ids = matches.map((node) => node.id);
  renderer.setSearchMatches(ids);
  if (center && ids.length > 0) renderer.centerOn(ids[0]);
  return ids;
}

async function reloadReplayMeta(): Promise<void> {
  if (!currentSession) return;
  const session = currentSession;
  try {
    const data = await fetchReplay(session);
    if (session !== currentSession) return;
    replay = data;
    replayIndex = mode === 'live' ? data.steps.length : Math.min(replayIndex, data.steps.length);
    updateTimeline();
  } catch {
    /* 保留旧回放数据，不阻塞渲染 */
  }
}

async function reloadClusters(): Promise<void> {
  if (!currentSession) return;
  const session = currentSession;
  try {
    const view = await fetchClusters(session);
    if (session !== currentSession) return;
    applyClusters(view);
  } catch {
    /* 簇命名失败退回无名轮廓 */
  }
}

function scheduleReplayMeta(): void {
  if (replayMetaTimer) window.clearTimeout(replayMetaTimer);
  replayMetaTimer = window.setTimeout(() => {
    replayMetaTimer = 0;
    void reloadReplayMeta();
  }, 400);
}

function scheduleClusters(): void {
  if (clusterTimer) window.clearTimeout(clusterTimer);
  clusterTimer = window.setTimeout(() => {
    clusterTimer = 0;
    void reloadClusters();
  }, 600);
}

function resetSessionState(): void {
  playing = false;
  stopTimer();
  replay = null;
  replayIndex = 0;
  mode = 'live';
  pendingLive = false;
  searchEl.value = '';
  renderer.setSearchMatches([]);
  clusterLabels = new Map();
  renderer.setClusterLabels(clusterLabels);
  panel.hide();
}

async function loadSession(sessionId: string): Promise<void> {
  resetSessionState();
  setState('加载回放与星图…', false);
  const [map, replayData] = await Promise.all([fetchMap(sessionId), fetchReplay(sessionId)]);
  if (sessionId !== currentSession) return;
  lastMap = map;
  replay = replayData;
  replayIndex = replayData.steps.length;
  mode = 'live';
  applyClusters(await fetchClusters(sessionId).catch(() => ({ sessionId, activeCount: 0, clusters: [], isolated: [] })));
  renderer.setMap(map);
  if (emptyEl) emptyEl.hidden = map.nodes.length > 0;
  applySearch(false);
  updateTimeline();
  setState(source ? '实时同步中' : '连接中', source !== null);
}

async function fetchMap(sessionId: string): Promise<GraphMap> {
  const res = await fetch(`/map?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error('加载星图失败');
  return (await res.json()) as GraphMap;
}

async function resumeLive(): Promise<void> {
  if (!currentSession) return;
  pause();
  mode = 'live';
  pendingLive = false;
  try {
    const [map, replayData] = await Promise.all([fetchMap(currentSession), fetchReplay(currentSession)]);
    if (!currentSession) return;
    lastMap = map;
    replay = replayData;
    replayIndex = replayData.steps.length;
    renderer.setMap(map, { animate: true });
    if (emptyEl) emptyEl.hidden = map.nodes.length > 0;
    applySearch(false);
    updateTimeline();
    setState('实时同步中', true);
    void reloadClusters();
  } catch {
    setState('恢复实时失败，请检查守护进程', false);
  }
}

async function refreshClusters(): Promise<void> {
  if (!currentSession) return;
  clusterBtn.disabled = true;
  clusterBtn.textContent = '命名中…';
  try {
    const res = await fetch('/clusters/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSession }),
    });
    if (res.ok) applyClusters((await res.json()) as ClusterView);
  } catch {
    /* 失败保持回退名 */
  } finally {
    clusterBtn.disabled = false;
    clusterBtn.textContent = '命名簇';
  }
}

async function runManual(action: ManualAction, nodeId: string): Promise<void> {
  if (!currentSession) throw new Error('未选择会话');
  const res = await fetch('/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: currentSession, action, nodeId }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; map?: GraphMap };
  if (!res.ok || !body.map) throw new Error(body.error ?? '操作失败');
  lastMap = body.map;
  renderer.setMap(body.map, { animate: true });
  if (emptyEl) emptyEl.hidden = body.map.nodes.length > 0;
  await reloadReplayMeta();
  if (mode === 'replay') seek(replay?.steps.length ?? 0, { pulse: false });
  if (action === 'delete') {
    panel.hide();
    renderer.clearFocus();
  } else {
    const node = body.map.nodes.find((item) => item.id === nodeId);
    if (node) renderer.focusNode(node.id);
  }
  applySearch(false);
  scheduleClusters();
}

function connectEvents(): void {
  source?.close();
  source = new EventSource('/events');
  source.onopen = () => {
    if (mode === 'live') setState('实时同步中', true);
  };
  source.onerror = () => setState('连接中断，自动重连', false);
  source.onmessage = (event) => {
    let update: GraphUpdate;
    try {
      update = JSON.parse(event.data) as GraphUpdate;
    } catch {
      return;
    }
    if (!update.map || update.sessionId !== currentSession) return;
    const option = Array.from(sessionSelect.options).find((o) => o.value === update.sessionId);
    if (option) option.textContent = `${update.sessionId.slice(0, 26)}… · ${update.map.nodes.length} 节点`;
    if (mode === 'live') {
      lastMap = update.map;
      renderer.setMap(update.map, { animate: true });
      if (emptyEl) emptyEl.hidden = update.map.nodes.length > 0;
      setState(`实时同步中 · 最新第 ${update.turnIndex} 轮`, true);
      applySearch(false);
    } else {
      pendingLive = true;
      setState(`回放中 · 有新数据（第 ${update.turnIndex} 轮）`, false);
    }
    scheduleReplayMeta();
    scheduleClusters();
  };
}

async function boot(): Promise<void> {
  let sessions: SessionInfo[] = [];
  try {
    sessions = await loadSessions();
  } catch {
    sessions = [];
  }
  sessionSelect.replaceChildren();
  if (sessions.length === 0) {
    sessionSelect.disabled = true;
    const option = document.createElement('option');
    option.textContent = '暂无会话';
    sessionSelect.append(option);
    setState('等待守护进程写入数据', false);
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  for (const session of sessions) {
    const option = document.createElement('option');
    option.value = session.sessionId;
    option.textContent = `${session.sessionId.slice(0, 26)}… · ${session.nodes} 节点`;
    sessionSelect.append(option);
  }
  const fromUrl = new URLSearchParams(location.search).get('session');
  currentSession = fromUrl && sessions.some((s) => s.sessionId === fromUrl) ? fromUrl : sessions[0].sessionId;
  sessionSelect.value = currentSession;

  sessionSelect.addEventListener('change', () => {
    if (!sessionSelect.value) return;
    currentSession = sessionSelect.value;
    panel.hide();
    void loadSession(currentSession);
  });

  timelineToggle.addEventListener('click', () => {
    if (playing) pause();
    else play();
  });
  timelineRange.addEventListener('input', () => {
    pause();
    seek(Number(timelineRange.value));
  });
  timelineSpeed.addEventListener('change', () => {
    speed = Number(timelineSpeed.value) || 1;
    if (playing) schedulePlayback();
    updateTimeline();
  });
  liveBtn.addEventListener('click', () => void resumeLive());

  searchEl.addEventListener('input', () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = 0;
      applySearch(true);
    }, 120);
  });

  clusterBtn.addEventListener('click', () => void refreshClusters());

  await loadSession(currentSession);
  Object.assign(window, { __atlasReadyAt: performance.now() });
  connectEvents();
}

Object.assign(window, {
  __atlas: {
    stats: () => renderer.getStats(),
    focus: (id: string) => renderer.focusNode(id),
    clearFocus: () => renderer.clearFocus(),
    pulse: (alpha = 0.6) => renderer.reheat(alpha),
    fit: () => renderer.fitView(),
    nodeScreen: (id: string) => renderer.screenOf(id),
    session: () => currentSession,
    map: () => lastMap,
    sessionCount: () => sessionSelect.options.length,
    timeline: () => ({
      index: replayIndex,
      total: replay?.steps.length ?? 0,
      playing,
      speed,
      mode,
      pendingLive,
      label: timelineLabel.textContent,
    }),
    play: () => play(),
    pause: () => pause(),
    seek: (index: number) => {
      pause();
      seek(index);
    },
    setSpeed: (value: number) => {
      speed = value || 1;
      timelineSpeed.value = String(speed);
      if (playing) schedulePlayback();
      updateTimeline();
    },
    setZoom: (k: number) => renderer.setZoom(k),
    zoom: () => renderer.getStats().zoom,
    search: (query: string) => {
      searchEl.value = query;
      return applySearch(true);
    },
    refreshClusters: () => refreshClusters(),
    labels: () => Object.fromEntries(clusterLabels),
    manual: (action: ManualAction, nodeId: string) => runManual(action, nodeId),
    panelNode: () => (panelEl.hidden ? null : panelEl.querySelector('.panel-title')?.textContent ?? null),
    panelText: () => (panelEl.hidden ? '' : panelEl.textContent ?? ''),
    live: () => resumeLive(),
  },
});

setState('连接中', false);
void boot();