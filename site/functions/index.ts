// Deno edge entry. The platform injects ./_qoder/backend.mjs at deploy time.
import { createDatabaseClient } from './_qoder/backend.mjs';
import { DeepSeekModel } from './lib/model.ts';
import { application } from './lib/routes.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const apiKey = Deno.env.get('DEEPSEEK_API_KEY')?.trim() ?? '';
const model = apiKey ? new DeepSeekModel(apiKey, fetch) : null;
const handler = application({ db: createDatabaseClient(), model });

Deno.serve(handler);