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