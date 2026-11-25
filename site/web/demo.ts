import { StarMapRenderer } from '../../packages/web/src/renderer.ts';
import type { GraphMap } from '../functions/lib/core/types.ts';
import {
  loadJson,
  mapAt,
  must,
  renderNodePanel,
  syntheticBanner,
  text,
  clear,
  downloadMapCard,
  type SampleDoc,
  type SampleManifest,
} from './common.ts';

const canvas = must<HTMLCanvasElement>('#map');
const panel = must<HTMLElement>('#panel');
const range = must<HTMLInputElement>('#range');
const playButton = must<HTMLButtonElement>('#play');
const restartButton = must<HTMLButtonElement>('#restart');
const exportButton = must<HTMLButtonElement>('#export');
const label = must<HTMLElement>('#turn-label');
const stats = must<HTMLElement>('#turn-stats');
const shiftList = must<HTMLElement>('#shift-list');
const title = must<HTMLElement>('#sample-title');
const summary = must<HTMLElement>('#sample-summary');
const tabs = must<HTMLElement>('#session-tabs');
const bannerSlot = must<HTMLElement>('#banner');
const chatLog = must<HTMLElement>('#chat-log');
const chatTurn = must<HTMLElement>('#chat-turn');
const realShots = must<HTMLElement>('#real-shots');

let manifest: SampleManifest | null = null;
let doc: SampleDoc | null = null;
let currentMap: GraphMap | null = null;
let renderer: StarMapRenderer | null = null;
let playing = false;
let timer = 0;

function currentTurn(): number {
  return Number(range.value);
}

function updateStats(map: GraphMap): void {
  const shifts = map.nodes.filter((node) => node.type === 'shift').length;
  const influences = map.edges.filter((edge) => edge.kind === 'influence').length;
  clear(stats);
  stats.append(
    text('span', `${map.nodes.length} 节点`, 'stat-nodes'),
    text('span', `${map.edges.length} 边`, 'stat-edges'),
    text('span', `${shifts} 次转折`, 'stat-shifts'),
    text('span', `${influences} 条影响`, 'stat-influences'),
  );
  shiftList.replaceChildren();
  for (const node of map.nodes.filter((entry) => entry.type === 'shift')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'shift-chip';
    button.textContent = node.label;
    button.addEventListener('click', () => {
      stopPlay();
      renderer?.focusNode(node.id);
    });
    shiftList.append(button);
  }
}

function renderChat(turn: number): void {
  if (!doc) return;
  chatTurn.textContent = turn === 0 ? '起点 · 0 轮' : `第 ${turn} / ${doc.session.turns.length} 轮`;
  clear(chatLog);
  if (turn === 0) {
    const hint = document.createElement('div');
    hint.className = 'bubble bubble-system';
    hint.append(text('p', '还没有对话。拖时间轴或点「从头播放」，这里会逐轮出现原文。'));
    chatLog.append(hint);
    return;
  }
  for (const entry of doc.session.turns) {
    if (entry.turnIndex > turn) break;
    const group = document.createElement('div');
    group.className = 'chat-turn';
    if (entry.turnIndex === turn) group.classList.add('latest');
    const user = document.createElement('div');
    user.className = 'bubble bubble-user';
    user.append(text('span', `第 ${entry.turnIndex} 轮 · 你`, 'bubble-role'), text('p', entry.userText));
    const ai = document.createElement('div');
    ai.className = 'bubble bubble-assistant';
    ai.append(text('span', `第 ${entry.turnIndex} 轮 · AI`, 'bubble-role'), text('p', entry.assistantText));
    group.append(user, ai);
    chatLog.append(group);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderAt(turn: number, animate = false): void {
  if (!doc) return;
  const map = mapAt(doc, turn);
  currentMap = map;
  renderer?.setMap(map, { animate });
  range.value = String(turn);
  label.textContent = turn === 0 ? '起点 · 0 轮' : `第 ${turn} / ${doc.session.turns.length} 轮`;
  updateStats(map);
  exportButton.disabled = map.nodes.length === 0;
  exportButton.title = map.nodes.length === 0 ? '当前轮次还没有节点，先播放或拖动进度' : '';
  renderChat(turn);
  if (turn === 0) {
    panel.hidden = true;
  }
}

function stopPlay(): void {
  playing = false;
  window.clearInterval(timer);
  playButton.textContent = '从头播放';
  playButton.setAttribute('aria-pressed', 'false');
}

function startPlay(): void {
  if (!doc) return;
  stopPlay();
  playing = true;
  playButton.textContent = '暂停';
  playButton.setAttribute('aria-pressed', 'true');
  renderAt(0);
  timer = window.setInterval(() => {
    if (!doc) return;
    const next = currentTurn() + 1;
    if (next > doc.session.turns.length) {
      stopPlay();
      return;
    }
    renderAt(next, true);
  }, 900);
}

function renderSession(docValue: SampleDoc): void {
  doc = docValue;
  realShots.hidden = doc.synthetic;
  title.textContent = doc.session.title;
  summary.textContent = doc.session.summary;
  range.max = String(doc.session.turns.length);
  range.value = String(doc.session.turns.length);
  renderAt(doc.session.turns.length);
  renderer?.reheat(0.8);
}

async function loadSession(file: string): Promise<void> {
  stopPlay();
  const loaded = await loadJson<SampleDoc>(`/samples/${file}`);
  renderSession(loaded);
  const url = new URL(window.location.href);
  url.searchParams.set('session', file.replace(/\.json$/, ''));
  window.history.replaceState(null, '', url);
  for (const button of tabs.querySelectorAll<HTMLButtonElement>('button')) {
    button.classList.toggle('active', button.dataset.file === file);
  }
}

async function boot(): Promise<void> {
  renderer = new StarMapRenderer(canvas, {
    stepOrder: true,
    onSelect: (node) => {
      if (doc && currentMap) renderNodePanel(panel, doc, currentMap, node?.id ?? null);
    },
  });
  panel.addEventListener('panel-close', () => renderer?.clearFocus());
  playButton.addEventListener('click', () => (playing ? stopPlay() : startPlay()));
  restartButton.addEventListener('click', () => {
    stopPlay();
    renderAt(0);
  });
  exportButton.addEventListener('click', () => {
    if (!doc || !renderer || !currentMap) return;
    const shifts = currentMap.nodes.filter((node) => node.type === 'shift').length;
    void downloadMapCard(renderer, {
      title: doc.session.title,
      stats: `${currentMap.nodes.length} 节点 · 第 ${currentTurn()} / ${doc.session.turns.length} 轮 · ${shifts} 次转折`,
      notice: doc.synthetic ? '合成演示数据 · 回放样例' : '真实会话样例 · 作者已授权公开',
      filename: `thought-atlas-${doc.session.id}.png`,
    });
  });
  range.addEventListener('input', () => {
    stopPlay();
    renderAt(currentTurn(), false);
  });

  manifest = await loadJson<SampleManifest>('/samples/manifest.json');
  bannerSlot.append(syntheticBanner(manifest));
  tabs.replaceChildren();
  for (const session of manifest.sessions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-tab';
    button.dataset.file = session.file;
    button.append(text('strong', session.title), text('span', `${session.stats.turns} 轮 · ${session.stats.nodes} 节点 · ${session.stats.shifts} 次转折`, 'tab-meta'));
    button.addEventListener('click', () => void loadSession(session.file));
    tabs.append(button);
  }
  const requested = new URL(window.location.href).searchParams.get('session');
  const chosen =
    manifest.sessions.find((session) => session.file === requested || session.file === `${requested}.json`) ??
    manifest.sessions.find((session) => session.id === requested || session.id.replace(/^sample-/, '') === requested) ??
    manifest.sessions[0];
  if (!chosen) throw new Error('样例清单为空');
  for (const button of tabs.querySelectorAll<HTMLButtonElement>('button')) {
    button.classList.toggle('active', button.dataset.file === chosen.file);
  }
  await loadSession(chosen.file);
  window.__atlasSite = {
    ready: true,
    turn: currentTurn,
    nodes: () => currentMap?.nodes.length ?? 0,
    chatBubbles: () => chatLog.querySelectorAll('.bubble').length,
    shifts: () => currentMap?.nodes.filter((node) => node.type === 'shift').length ?? 0,
    selectFirstShift: () => {
      const shift = currentMap?.nodes.find((node) => node.type === 'shift');
      if (!shift) return false;
      renderer?.focusNode(shift.id);
      return true;
    },
    panelVisible: () => !panel.hidden && panel.textContent!.includes('锚点原文'),
    settled: () => renderer?.getStats().converged ?? false,
    fit: () => renderer?.fitView(),
    zoom: () => renderer?.getStats().zoom ?? 0,
    setZoom: (k: number) => renderer?.setZoom(k),
  };
  window.__atlasReadyAt = performance.now();
}

void boot().catch((error: unknown) => {
  bannerSlot.append(text('p', `样例加载失败：${error instanceof Error ? error.message : String(error)}`, 'error-text'));
});