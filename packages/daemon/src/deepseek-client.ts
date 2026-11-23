import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelClient, ModelRequest, ModelResponse } from '@thought-atlas/core';
import { atlasHome } from './fs-storage.ts';

interface AtlasConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  port?: number;
  language?: string;
}

export async function loadConfig(home: string = atlasHome()): Promise<AtlasConfig> {
  const raw = await readFile(join(home, 'config.json'), 'utf8');
  const config = JSON.parse(raw) as AtlasConfig;
  if (!config.apiKey || !config.baseUrl || !config.model) {
    throw new Error('config.json missing apiKey/baseUrl/model');
  }
  return config;
}

export class DeepSeekClient implements ModelClient {
  private config: AtlasConfig;

  constructor(config: AtlasConfig) {
    this.config = config;
  }

  static async fromConfig(home?: string): Promise<DeepSeekClient> {
    return new DeepSeekClient(await loadConfig(home));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const res = await fetch(this.config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          temperature: Math.min(request.temperature, 0.3),
          ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
          // flash 默认开思考且思考模式下 temperature 失效；分析任务要低延迟稳定 JSON，显式关闭
          ...(this.config.model.startsWith('deepseek') ? { thinking: { type: 'disabled' } } : {}),
          max_tokens: 2000,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`model HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('model response missing content');
      // JSON output 模式下无法识别为 JSON 时 API 会把内容替换为空格（官方文档），按调用失败触发重试
      if (request.jsonMode && text.trim().length === 0) throw new Error('model returned blank json content');
      return {
        text,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
        },
        latencyMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}