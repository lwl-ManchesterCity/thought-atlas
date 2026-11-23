import { StarMapRenderer } from '../../packages/web/src/renderer.ts';
import type { GraphMap } from '../functions/lib/core/types.ts';
import {
  clear,
  must,
  renderNodePanel,
  text,
  type SampleDoc,
  type SampleTurn,
} from './common.ts';

interface Limits {
  turnsPerSession: number;
  sessionTurnsRemaining: number;
  analysesPerDay: number;
  analysesRemaining: number;
  sessionsRemaining?: number;
}

interface TurnResponse {
  sessionId: string;
  turnIndex: number;
  reply: string;
  status: 'applied' | 'skipped' | 'cache_hit' | 'analysis_failed';
  notice?: string;
  map: GraphMap;
  limits: Limits;
}

interface ErrorResponse {
  error: string;
  message: string;
}

const API = '/functions/v1/app';
const STORAGE_KEY = 'thought-atlas-sandbox-session';

const log = must<HTMLElement>('#chat-log');
const form = must<HTMLFormElement>('#composer');
const input = must<HTMLTextAreaElement>('#message');
const send = must<HTMLButtonElement>('#send');
const counter = must<HTMLElement>('#char-count');
const statusLine = must<HTMLElement>('#status');
const limitsLine = must<HTMLElement>('#limits');
const panel = must<HTMLElement>('#panel');
const canvas = must<HTMLCanvasElement>('#map');
const newButton = must<HTMLButtonElement>('#new-session');

let renderer: StarMapRenderer;
let sessionId: string | null = null;
let sessionTurns: SampleTurn[] = [];
let map: GraphMap = { sessionId: '', nodes: [], edges: [], lastTurn: 0 };
let pending = false;

function docFor(mapValue: GraphMap): SampleDoc {
  return {
    synthetic: false,
    notice: '沙箱原文只在本页内存，刷新即消失；服务端只保存输入哈希、限流计数与分析结果图。',
    session: {
      id: mapValue.sessionId || sessionId || 'sandbox',
      title: '实时沙箱',
      summary: '',
      turns: sessionTurns,
      events: [],
      map: mapValue,
      stats: { turns: mapValue.lastTurn, nodes: mapValue.nodes.length, edges: mapValue.edges.length, shifts: 0, influences: 0, types: {} },
    },
  };
}

function newTurn(turnIndex: number, userText: string, assistantText: string): SampleTurn {
  return { turnIndex, timestamp: new Date().toISOString(), userText, assistantText };
}

function bubble(role: 'user' | 'assistant' | 'system', content: string): HTMLElement {
  const row = document.createElement('div');
  row.className = `bubble bubble-${role}`;
  row.append(text('span', role === 'user' ? '你' : role === 'assistant' ? '星图' : '提示', 'bubble-role'));
  row.append(text('p', content));
  log.append(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

function setLimits(limits: Limits | null): void {
  clear(limitsLine);
  if (!limits) {
    limitsLine.append(text('span', '等待第一条消息…'));
    return;
  }
  limitsLine.append(
    text('span', `本会话剩余 ${limits.sessionTurnsRemaining} / ${limits.turnsPerSession} 轮`),
    text('span', `今日全站剩余分析 ${limits.analysesRemaining} / ${limits.analysesPerDay} 轮`),
  );
}

function setStatus(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  statusLine.textContent = message;
  statusLine.dataset.kind = kind;
}

function setPending(value: boolean): void {
  pending = value;
  send.disabled = value;
  input.disabled = value;
  for (const button of form.querySelectorAll<HTMLButtonElement>('button')) button.disabled = value;
}

function updateMap(mapValue: GraphMap): void {
  map = mapValue;
  renderer.setMap(mapValue, { animate: true });
  renderer.reheat(0.5);
  panel.hidden = true;
}

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T | ErrorResponse }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({ error: 'invalid_response', message: '服务返回了无法解析的内容' }))) as T | ErrorResponse;
  return { ok: res.ok, status: res.status, data };
}

async function ensureSession(): Promise<string | null> {
  if (sessionId) return sessionId;
  const res = await api<{ sessionId: string; limits: Limits }>('/api/sandbox/session', { method: 'POST', body: '{}' });
  if (!res.ok) {
    const error = res.data as ErrorResponse;
    bubble('system', error.message || '无法创建沙箱会话');
    setStatus(error.message, 'error');
    if (error.error === 'session_limit') {
      bubble('system', '每个 IP 每日最多 3 次体验会话。可以先去回放样例看完整星图。');
    }
    return null;
  }
  const data = res.data as { sessionId: string; limits: Limits };
  sessionId = data.sessionId;
  sessionStorage.setItem(STORAGE_KEY, sessionId);
  sessionTurns = [];
  updateMap({ sessionId, nodes: [], edges: [], lastTurn: 0 });
  setLimits({ ...data.limits, sessionTurnsRemaining: data.limits.turnsPerSession, analysesRemaining: data.limits.analysesPerDay, analysesPerDay: data.limits.analysesPerDay });
  return sessionId;
}

async function restore(): Promise<void> {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (!stored) return;
  const res = await api<{ sessionId: string; map: GraphMap; lastTurn: number; limits: Limits }>(`/api/sandbox/session?id=${encodeURIComponent(stored)}`);
  if (!res.ok) {
    sessionStorage.removeItem(STORAGE_KEY);
    return;
  }
  const data = res.data as { sessionId: string; map: GraphMap; lastTurn: number; limits: Limits };
  sessionId = data.sessionId;
  sessionTurns = [];
  updateMap(data.map);
  setLimits(data.limits);
  if (data.map.nodes.length > 0) setStatus('已恢复上次会话的星图，可继续聊。');
  bubble('system', '已恢复本会话的星图（原文未保存，锚点原文仅本页新消息可见）。');
}

async function sendTurn(userText: string): Promise<void> {
  const id = await ensureSession();
  if (!id) return;
  setPending(true);
  setStatus('分析中…');
  const userBubble = bubble('user', userText);
  const typing = bubble('assistant', '正在分析这一轮…');
  try {
    const res = await api<TurnResponse>('/api/sandbox/turn', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, text: userText }),
    });
    if (!res.ok) {
      const error = res.data as ErrorResponse;
      typing.remove();
      bubble('system', error.message || '本轮发送失败');
      setStatus(error.message, error.error === 'quota_exhausted' ? 'warn' : 'error');
      if (error.error === 'session_limit') {
        bubble('system', '体验会话次数已用完，可以先去回放样例。');
      }
      return;
    }
    const data = res.data as TurnResponse;
    const content = typing.querySelector('p');
    if (content) content.textContent = data.reply;
    else typing.append(text('p', data.reply));
    sessionTurns.push(newTurn(data.turnIndex, userText, data.reply));
    updateMap(data.map);
    setLimits(data.limits);
    const messages: Record<TurnResponse['status'], string> = {
      applied: `第 ${data.turnIndex} 轮已写入星图。`,
      skipped: `第 ${data.turnIndex} 轮没有值得新建的观点（SKIP），星图保持不变。`,
      cache_hit: `第 ${data.turnIndex} 轮命中输入缓存，未调用模型。`,
      analysis_failed: data.notice ?? '本轮分析失败，聊天不受影响。',
    };
    setStatus(messages[data.status], data.status === 'analysis_failed' ? 'warn' : 'info');
    if (data.limits.sessionTurnsRemaining <= 0) {
      bubble('system', '本会话已达 20 轮上限。可以新开一个会话，或回到回放样例。');
    }
  } catch (error) {
    typing.remove();
    bubble('system', `网络或服务异常：${error instanceof Error ? error.message : String(error)}`);
    setStatus('网络或服务异常，请稍后再试', 'error');
  } finally {
    setPending(false);
    updateCounter();
    input.focus();
    userBubble.scrollIntoView({ block: 'nearest' });
  }
}

function updateCounter(): void {
  const length = [...input.value].length;
  counter.textContent = `${length} / 2000 字`;
  counter.classList.toggle('over', length > 2000);
  send.disabled = pending || length === 0 || length > 2000;
}

function boot(): void {
  renderer = new StarMapRenderer(canvas, {
    onSelect: (node) => renderNodePanel(panel, docFor(map), map, node?.id ?? null),
  });
  panel.addEventListener('panel-close', () => renderer.clearFocus());
  input.addEventListener('input', updateCounter);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value || pending) return;
    if ([...value].length > 2000) {
      setStatus('单轮内容不能超过 2000 字', 'error');
      return;
    }
    input.value = '';
    updateCounter();
    void sendTurn(value);
  });
  newButton.addEventListener('click', () => {
    sessionId = null;
    sessionStorage.removeItem(STORAGE_KEY);
    sessionTurns = [];
    log.replaceChildren();
    updateMap({ sessionId: '', nodes: [], edges: [], lastTurn: 0 });
    setLimits(null);
    setStatus('新会话将在下一条消息时创建。');
    bubble('system', '已清空本页视图。下一条消息会创建新的体验会话（计入每日 3 次限额）。');
  });

  bubble('system', '这里是在线迷你沙箱：边聊边看星图生长。每个 IP 每日 3 次会话、单会话 20 轮、全站每日 100 轮分析；原文不留存。');
  setLimits(null);
  updateCounter();
  updateMap({ sessionId: '', nodes: [], edges: [], lastTurn: 0 });

  void api<{ ok: boolean; configured: boolean; model: string }>('/api/health').then((res) => {
    if (!res.ok) return;
    const data = res.data as { configured: boolean };
    if (!data.configured) {
      bubble('system', '演示服务尚未配置模型密钥，聊天与星图暂不可用；回放样例不受影响。');
      setStatus('模型密钥未配置，沙箱暂停。', 'warn');
    }
  }).catch(() => {});
  void restore();
  window.__atlasSite = {
    ready: true,
    nodes: () => map.nodes.length,
    session: () => sessionId,
    status: () => statusLine.textContent ?? '',
    map: () => map,
    focusFirstNode: () => {
      const node = map.nodes[0];
      if (!node) return false;
      renderer.focusNode(node.id);
      return true;
    },
    settled: () => renderer.getStats().converged,
    fit: () => renderer.fitView(),
  };
  window.__atlasReadyAt = performance.now();
}

boot();