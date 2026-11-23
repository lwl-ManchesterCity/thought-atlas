import type { ThoughtNode } from '@thought-atlas/core';
import { nodeTypeLabel } from './graph-model.ts';

export interface AnchorTurn {
  turnIndex: number;
  userText: string;
  assistantText: string;
}

export interface AnchorPayload {
  found: boolean;
  anchorTurns: number[];
  turns: AnchorTurn[];
}

export type ManualAction = 'mark-shift' | 'delete';

export interface DetailPanelOptions {
  onClose: () => void;
  loadAnchors: (nodeId: string) => Promise<AnchorPayload>;
  onManual: (action: ManualAction, nodeId: string) => Promise<void>;
}

export interface DetailPanel {
  show: (node: ThoughtNode) => void;
  hide: () => void;
}

export function createPanel(root: HTMLElement, options: DetailPanelOptions): DetailPanel {
  root.replaceChildren();

  const close = document.createElement('button');
  close.className = 'panel-close';
  close.type = 'button';
  close.textContent = '关闭';
  close.addEventListener('click', options.onClose);

  const title = document.createElement('div');
  title.className = 'panel-title';

  const typeRow = document.createElement('div');
  typeRow.className = 'panel-row';

  const summary = document.createElement('p');
  summary.className = 'panel-summary';

  const rings = document.createElement('div');
  rings.className = 'panel-rings';

  const meta = document.createElement('div');
  meta.className = 'panel-meta';

  const anchors = document.createElement('section');
  anchors.className = 'panel-anchors';
  const anchorsTitle = document.createElement('div');
  anchorsTitle.className = 'panel-section-title';
  anchorsTitle.textContent = '锚点原文';
  const anchorsHint = document.createElement('div');
  anchorsHint.className = 'panel-hint';
  anchorsHint.textContent = '仅读取本地 ~/.thought-atlas 记录，不上传';
  const anchorsStatus = document.createElement('div');
  anchorsStatus.className = 'panel-hint';
  const anchorsList = document.createElement('div');
  anchorsList.className = 'anchor-list';
  anchors.append(anchorsTitle, anchorsHint, anchorsStatus, anchorsList);

  const actions = document.createElement('div');
  actions.className = 'panel-actions';
  const shiftBtn = document.createElement('button');
  shiftBtn.type = 'button';
  shiftBtn.className = 'panel-action';
  shiftBtn.textContent = '标记为转变';
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'panel-action panel-action-danger';
  deleteBtn.textContent = '删除节点';
  const actionMsg = document.createElement('div');
  actionMsg.className = 'panel-hint';
  actions.append(shiftBtn, deleteBtn, actionMsg);

  root.append(close, title, typeRow, summary, rings, meta, anchors, actions);

  let current: ThoughtNode | null = null;
  let token = 0;
  let busy = false;

  function setBusy(next: boolean, message = ''): void {
    busy = next;
    shiftBtn.disabled = next || !canShift(current);
    deleteBtn.disabled = next || current === null;
    actionMsg.textContent = message;
  }

  function canShift(node: ThoughtNode | null): boolean {
    if (!node) return false;
    return node.type !== 'ai-voice' && node.type !== 'shift' && node.status === 'active';
  }

  async function loadAnchors(node: ThoughtNode): Promise<void> {
    const mine = ++token;
    anchorsStatus.textContent = '读取中…';
    anchorsList.replaceChildren();
    try {
      const payload = await options.loadAnchors(node.id);
      if (mine !== token) return;
      if (!payload.found || payload.turns.length === 0) {
        anchorsStatus.textContent = '暂无锚点原文（本地未记录对应轮次）';
        return;
      }
      anchorsStatus.textContent = `共 ${payload.turns.length} 轮原文`;
      for (const turn of payload.turns) {
        const block = document.createElement('div');
        block.className = 'anchor-turn';
        const head = document.createElement('div');
        head.className = 'anchor-head';
        head.textContent = `第 ${turn.turnIndex} 轮`;
        const user = document.createElement('div');
        user.className = 'anchor-text anchor-user';
        user.textContent = `用户：${turn.userText}`;
        const assistant = document.createElement('div');
        assistant.className = 'anchor-text anchor-assistant';
        assistant.textContent = `助手：${turn.assistantText}`;
        block.append(head, user, assistant);
        anchorsList.append(block);
      }
    } catch {
      if (mine !== token) return;
      anchorsStatus.textContent = '锚点原文读取失败';
    }
  }

  shiftBtn.addEventListener('click', () => {
    if (!current || busy || !canShift(current)) return;
    const node = current;
    setBusy(true, '正在写入事件日志…');
    void options
      .onManual('mark-shift', node.id)
      .then(() => setBusy(false, '已标记为认知转变'))
      .catch((err: unknown) => setBusy(false, err instanceof Error ? err.message : '操作失败'));
  });

  deleteBtn.addEventListener('click', () => {
    if (!current || busy) return;
    const node = current;
    setBusy(true, '正在写入事件日志…');
    void options
      .onManual('delete', node.id)
      .then(() => setBusy(false, '已删除'))
      .catch((err: unknown) => setBusy(false, err instanceof Error ? err.message : '操作失败'));
  });

  return {
    show(node: ThoughtNode): void {
      current = node;
      root.hidden = false;
      title.textContent = node.label;
      typeRow.textContent = nodeTypeLabel(node.type);
      summary.textContent = node.summary || '（无摘要）';
      const turns = node.rings.join('、');
      rings.textContent = node.rings.length > 0 ? `年轮 ×${node.rings.length} · 第 ${turns} 轮` : '尚无年轮';
      const status = node.status === 'active' ? '活跃' : node.status === 'superseded' ? '已被取代' : '已合并';
      meta.textContent = `${status} · 第 ${node.bornTurn} 轮出现 · ${node.id}`;
      root.dataset.type = node.type;
      root.dataset.status = node.status;
      shiftBtn.title = canShift(node) ? '追加 MARK_SHIFT 事件，可在回放中查看' : 'AI 观点、转变或非活跃节点不可标记';
      setBusy(false, '');
      void loadAnchors(node);
    },
    hide(): void {
      current = null;
      token++;
      busy = false;
      root.hidden = true;
    },
  };
}