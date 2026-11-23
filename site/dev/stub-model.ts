import type { ModelRequest, ModelResponse } from '../functions/lib/core/ports.ts';
import type { HostedModel } from '../functions/lib/model.ts';

export class StubModel implements HostedModel {
  chatCalls = 0;
  completeCalls = 0;
  selfcheckCalls = 0;
  failChat = false;
  failComplete = false;
  analyzerText: ((turn: number) => string) | null = null;
  chatText: ((text: string) => string) | null = null;

  async chat(userText: string, skeletonLabels: string[]): Promise<{ text: string; latencyMs: number }> {
    this.chatCalls++;
    if (this.failChat) throw new Error('stub chat failure');
    const reply = this.chatText
      ? this.chatText(userText)
      : `合成回复：${userText.slice(0, 60)}${skeletonLabels.length ? `（已看过 ${skeletonLabels.length} 个节点）` : ''}`;
    return { text: reply, latencyMs: 3 };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.completeCalls++;
    if (this.failComplete) throw new Error('stub complete failure');
    const turn = Number(/当前轮次:\s*(\d+)/.exec(request.user)?.[1] ?? 1);
    const text = this.analyzerText
      ? this.analyzerText(turn)
      : JSON.stringify({
        ops: [{
          op: 'ADD_NODE',
          node: {
            type: 'claim',
            label: `合成观点${turn}`,
            summary: `第 ${turn} 轮合成分析生成的节点`,
          },
        }],
      });
    return { text, usage: { promptTokens: 12, completionTokens: 8 }, latencyMs: 4 };
  }

  async selfcheck(): Promise<{ ok: boolean; latencyMs: number }> {
    this.selfcheckCalls++;
    return { ok: !this.failComplete, latencyMs: 2 };
  }
}