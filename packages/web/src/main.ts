import type { GraphMap, GraphUpdate, ThoughtNode } from '@thought-atlas/core';
import { StarMapRenderer, type RendererStats } from './renderer.ts';
import { createPanel } from './panel.ts';

interface SessionInfo {
  sessionId: string;
  lastTurn: number;
  nodes: number;
  edges: number;
  updatedAt: string;
}

function must<T extends Element>(el: T | null, name: string): T {
  if (!el) throw new Error(`页面结构缺失: ${name}`);
  return el;
}

const canvas = must(document.querySelector<HTMLCanvasElement>('#map'), '#map');
const panelEl = must(document.querySelector<HTMLElement>('#panel'), '#panel');
const sessionSelect = must(document.querySelector<HTMLSelectElement>('#session'), '#session');
const statsEl = must(document.querySelector<HTMLElement>('#stats'), '#stats');
const stateEl = must(document.querySelector<HTMLElement>('#live-state'), '#live-state');
const emptyEl = document.querySelector<HTMLElement>('#empty-hint');

const panel = createPanel(panelEl, () => renderer.clearFocus());
const renderer = new StarMapRenderer(canvas, {
  onSelect: (node: ThoughtNode | null) => (node ? panel.show(node) : panel.hide()),
  onStats: updateStats,
});

let currentSession: string | null = null;
let lastMap: GraphMap | null = null;
let source: EventSource | null = null;

function updateStats(stats: RendererStats): void {
  const parts = [
    `${stats.nodes} 节点`,
    `${stats.edges} 连线`,
    `${stats.converged ? '已稳定' : '布局中'}`,
    `${stats.fps} fps`,
  ];
  statsEl.textContent = parts.join(' · ');
}

function setState(text: string, live: boolean): void {
  stateEl.textContent = text;
  stateEl.dataset.live = live ? 'on' : 'off';
}

async function loadSessions(): Promise<SessionInfo[]> {
  const res = await fetch('/sessions');
  if (!res.ok) throw new Error('加载会话列表失败');
  return (await res.json()) as SessionInfo[];
}

async function loadSession(sessionId: string): Promise<void> {
  const res = await fetch(`/map?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error('加载星图失败');
  const map = (await res.json()) as GraphMap;
  lastMap = map;
  renderer.setMap(map);
  const info = map.nodes.length === 0 ? '暂无节点' : `第 ${map.lastTurn} 轮`;
  statsEl.textContent = `${map.nodes.length} 节点 · ${map.edges.length} 连线 · ${info}`;
  if (emptyEl) emptyEl.hidden = map.nodes.length > 0;
}

function connectEvents(): void {
  source?.close();
  source = new EventSource('/events');
  source.onopen = () => setState('实时同步中', true);
  source.onerror = () => setState('连接中断，自动重连', false);
  source.onmessage = (event) => {
    let update: GraphUpdate;
    try {
      update = JSON.parse(event.data) as GraphUpdate;
    } catch {
      return;
    }
    if (!update.map || update.sessionId !== currentSession) return;
    lastMap = update.map;
    renderer.setMap(update.map, { animate: true });
    const option = Array.from(sessionSelect.options).find((o) => o.value === update.sessionId);
    if (option) option.textContent = `${update.sessionId.slice(0, 26)}… · ${update.map.nodes.length} 节点`;
    if (emptyEl) emptyEl.hidden = update.map.nodes.length > 0;
    setState(`实时同步中 · 最新第 ${update.turnIndex} 轮`, true);
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
  },
});

setState('连接中', false);
void boot();