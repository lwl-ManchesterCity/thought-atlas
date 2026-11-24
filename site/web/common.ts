import type { EventRecord, GraphMap, ThoughtNode } from '../functions/lib/core/types.ts';
import { foldEvents } from '../functions/lib/core/index.ts';
import { nodeTypeLabel } from '../../packages/web/src/graph-model.ts';
import type { StarMapRenderer } from '../../packages/web/src/renderer.ts';

export interface SampleTurn {
  turnIndex: number;
  timestamp: string;
  userText: string;
  assistantText: string;
}

export interface SampleStats {
  turns: number;
  nodes: number;
  edges: number;
  shifts: number;
  influences: number;
  types: Record<string, number>;
}

export interface SampleDoc {
  synthetic: boolean;
  notice: string;
  session: {
    id: string;
    title: string;
    summary: string;
    turns: SampleTurn[];
    events: { turnIndex: number; timestamp: string; ops: unknown[] }[];
    map: GraphMap;
    stats: SampleStats;
  };
}

export interface SampleManifest {
  synthetic: boolean;
  notice: string;
  generatedAt: string;
  realSamplesApproved: boolean;
  sessions: { file: string; id: string; title: string; summary: string; stats: SampleStats }[];
}

export function must<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

export function text(tag: string, value: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function emptyMap(sessionId: string): GraphMap {
  return { sessionId, nodes: [], edges: [], lastTurn: 0 };
}

export function mapAt(doc: SampleDoc, turn: number): GraphMap {
  if (turn <= 0) return emptyMap(doc.session.id);
  return foldEvents(doc.session.id, doc.session.events as EventRecord[], turn);
}

export async function downloadMapCard(
  renderer: StarMapRenderer,
  meta: { title: string; stats: string; notice: string; filename: string },
): Promise<void> {
  const img = new Image();
  img.src = renderer.exportPng();
  await img.decode();
  const w = img.width;
  const u = w / 1200;
  const headH = Math.round(110 * u);
  const footH = Math.round(76 * u);
  const card = document.createElement('canvas');
  card.width = w;
  card.height = img.height + headH + footH;
  const ctx = card.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#f7f9fc';
  ctx.fillRect(0, 0, card.width, card.height);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#0f172a';
  ctx.font = `600 ${Math.round(30 * u)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(meta.title, Math.round(36 * u), Math.round(52 * u));
  ctx.fillStyle = '#64748b';
  ctx.font = `${Math.round(16 * u)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText('思维星图 · THOUGHT ATLAS', Math.round(36 * u), Math.round(84 * u));
  ctx.drawImage(img, 0, headH);
  ctx.fillStyle = '#334155';
  ctx.font = `${Math.round(18 * u)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(meta.stats, Math.round(36 * u), headH + img.height + Math.round(32 * u));
  ctx.fillStyle = '#94a3b8';
  ctx.font = `${Math.round(14 * u)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(meta.notice, Math.round(36 * u), headH + img.height + Math.round(58 * u));
  const link = document.createElement('a');
  link.href = card.toDataURL('image/png');
  link.download = meta.filename;
  link.click();
}

export function nodeStatusLabel(node: ThoughtNode): string {
  if (node.status === 'superseded') return '已被取代';
  if (node.status === 'merged') return '已合并';
  return '活跃';
}

export function nodeTypeText(node: ThoughtNode): string {
  return nodeTypeLabel(node.type);
}

export function turnFor(doc: SampleDoc, turnIndex: number): SampleTurn | null {
  return doc.session.turns.find((turn) => turn.turnIndex === turnIndex) ?? null;
}

export function renderNodePanel(
  container: HTMLElement,
  doc: SampleDoc,
  map: GraphMap,
  nodeId: string | null,
): void {
  clear(container);
  if (!nodeId) {
    container.hidden = true;
    return;
  }
  const node = map.nodes.find((entry) => entry.id === nodeId);
  if (!node) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const head = document.createElement('div');
  head.className = 'panel-head';
  const badge = text('span', nodeTypeText(node), `type-badge type-${node.type}`);
  const title = text('h2', node.label, 'panel-title');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn';
  close.setAttribute('aria-label', '关闭节点面板');
  close.textContent = '×';
  close.addEventListener('click', () => {
    container.dispatchEvent(new CustomEvent('panel-close', { bubbles: true }));
  });
  head.append(badge, close);
  container.append(head, title);

  const meta = text('p', `${nodeStatusLabel(node)} · 第 ${node.bornTurn} 轮出现 · 年轮 ${node.rings.length} 层`, 'panel-meta');
  container.append(meta);

  if (node.summary) container.append(text('p', node.summary, 'panel-summary'));

  if (node.shift) {
    const shift = document.createElement('div');
    shift.className = 'shift-note';
    shift.append(text('span', '转变立场', 'kicker'));
    shift.append(text('p', node.shift.toSummary));
    if (node.shift.triggerTurn) {
      shift.append(text('p', `触发于第 ${node.shift.triggerTurn} 轮`, 'panel-meta'));
    }
    container.append(shift);
  }

  const anchors = node.anchorTurns.length ? node.anchorTurns : [node.bornTurn];
  const anchorTitle = text('h3', '锚点原文', 'panel-section');
  container.append(anchorTitle);
  for (const turnIndex of anchors) {
    const turn = turnFor(doc, turnIndex);
    if (!turn) continue;
    const block = document.createElement('article');
    block.className = 'anchor';
    block.append(text('span', `第 ${turnIndex} 轮 · 你`, 'anchor-who'));
    block.append(text('p', turn.userText, 'anchor-user'));
    block.append(text('span', 'AI', 'anchor-who'));
    block.append(text('p', turn.assistantText, 'anchor-ai'));
    container.append(block);
  }

  if (node.type !== 'shift') {
    const linked = map.edges.filter((edge) => edge.from === node.id || edge.to === node.id);
    if (linked.length) {
      container.append(text('h3', '关联', 'panel-section'));
      const list = document.createElement('ul');
      list.className = 'link-list';
      for (const edge of linked) {
        const otherId = edge.from === node.id ? edge.to : edge.from;
        const other = map.nodes.find((entry) => entry.id === otherId);
        if (!other) continue;
        const item = document.createElement('li');
        const kind = edge.kind === 'influence' ? '影响' : edge.kind === 'supersede' ? '取代' : '相关';
        item.append(text('span', kind, 'link-kind'), text('span', other.label));
        list.append(item);
      }
      container.append(list);
    }
  }
}

export function syntheticBanner(manifest: SampleManifest): HTMLElement {
  const banner = document.createElement('p');
  banner.className = 'synthetic-banner';
  banner.textContent = manifest.synthetic
    ? `合成演示数据 · 公开样例当前全部为合成生成，不含真实会话 · ${manifest.notice}`
    : manifest.notice;
  return banner;
}

export function highlightNav(): void {
  const page = document.body.dataset.page;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-nav]')) {
    const active = link.dataset.nav === page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
  }
}

export interface AtlasDiagnostics {
  ready: boolean;
  nodes: () => number;
  chatBubbles?: () => number;
  turn?: () => number;
  shifts?: () => number;
  selectFirstShift?: () => boolean;
  panelVisible?: () => boolean;
  session?: () => string | null;
  status?: () => string;
  map?: () => GraphMap;
  focusFirstNode?: () => boolean;
  settled?: () => boolean;
  fit?: () => void;
  setTurn?: (t: number) => void;
  zoom?: () => number;
  setZoom?: (k: number) => number | undefined;
}

declare global {
  interface Window {
    __atlasSite?: AtlasDiagnostics;
    __atlasReadyAt?: number;
    __xss?: boolean;
  }
}

highlightNav();