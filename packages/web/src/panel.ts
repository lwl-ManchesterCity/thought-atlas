import type { ThoughtNode } from '@thought-atlas/core';
import { nodeTypeLabel } from './graph-model.ts';

export interface DetailPanel {
  show: (node: ThoughtNode) => void;
  hide: () => void;
}

export function createPanel(root: HTMLElement, onClose: () => void): DetailPanel {
  root.replaceChildren();

  const close = document.createElement('button');
  close.className = 'panel-close';
  close.type = 'button';
  close.textContent = '关闭';
  close.addEventListener('click', onClose);

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

  root.append(close, title, typeRow, summary, rings, meta);

  return {
    show(node: ThoughtNode): void {
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
    },
    hide(): void {
      root.hidden = true;
      root.replaceChildren();
      root.append(close, title, typeRow, summary, rings, meta);
    },
  };
}