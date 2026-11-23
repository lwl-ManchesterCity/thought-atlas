import type { TurnPayload } from './types.ts';

export interface FilterResult {
  skip: boolean;
  reason?: 'too-short' | 'ack-only' | 'near-duplicate';
}

const ACK_WORDS = new Set([
  '好的', '好', '好呀', '嗯', '嗯嗯', '哦', '噢', '行', '可以', '对', '对的',
  '是的', '是', '继续', '下一步', '跑一下', '运行一下', '执行吧', '开始吧',
  '谢谢', '感谢', '收到', '明白', '懂了', 'ok', 'okay', 'yes', 'y', 'go',
  'next', 'continue', 'thanks', 'thx', 'k',
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 && nb.length === 0) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let overlap = 0;
  for (const [gram, count] of ga) {
    overlap += Math.min(count, gb.get(gram) ?? 0);
  }
  return (2 * overlap) / (na.length - 1 + nb.length - 1);
}

export function filterTurn(
  payload: TurnPayload,
  previous?: TurnPayload,
): FilterResult {
  const combined = payload.userText + payload.assistantText;
  if (normalize(combined).length < 20) {
    return { skip: true, reason: 'too-short' };
  }
  const userNorm = normalize(payload.userText);
  const tokens = userNorm.split(/[，,。！!.、？?~～]+/u).filter(Boolean);
  if (tokens.length > 0 && tokens.every((t) => ACK_WORDS.has(t))) {
    return { skip: true, reason: 'ack-only' };
  }
  if (previous) {
    const prevText = previous.userText + previous.assistantText;
    if (similarity(combined, prevText) > 0.95) {
      return { skip: true, reason: 'near-duplicate' };
    }
  }
  return { skip: false };
}