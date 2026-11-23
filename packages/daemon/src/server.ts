import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ThoughtGraph,
  filterTurn,
  analyzeTurn,
} from '@thought-atlas/core';
import type {
  TurnPayload,
  ModelClient,
  Storage,
  GraphUpdate,
  RecentSummary,
  SourcePlatform,
  MapOp,
} from '@thought-atlas/core';
import { FsStorage, atlasHome } from './fs-storage.ts';

export interface DaemonOptions {
  model: ModelClient;
  home?: string;
  port?: number;
  storageFactory?: (sessionId: string) => Storage;
  retryIntervalMs?: number;
  maxRetryAttempts?: number;
}

export interface IngestResult {
  status: 'applied' | 'skipped' | 'duplicate' | 'retry_queued' | 'rejected';
  reason?: string;
  opsCount?: number;
}

export interface RetryEntry {
  payload: TurnPayload;
  attempts: number;
  lastError: string;
  queuedAt: string;
}

const SOURCES = new Set<SourcePlatform>(['qoder', 'claude-code', 'zcode', 'codex', 'watcher', 'sandbox']);
const MAX_BODY = 1024 * 1024;

function validatePayload(input: unknown): TurnPayload | null {
  if (typeof input !== 'object' || input === null) return null;
  const p = input as Record<string, unknown>;
  if (typeof p.sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(p.sessionId)) return null;
  if (typeof p.turnIndex !== 'number' || !Number.isInteger(p.turnIndex) || p.turnIndex < 1) return null;
  if (typeof p.userText !== 'string' || typeof p.assistantText !== 'string') return null;
  if (typeof p.timestamp !== 'string') return null;
  if (!SOURCES.has(p.source as SourcePlatform)) return null;
  return {
    sessionId: p.sessionId,
    turnIndex: p.turnIndex,
    userText: p.userText,
    assistantText: p.assistantText,
    timestamp: p.timestamp,
    source: p.source as SourcePlatform,
  };
}

export class AtlasDaemon {
  private model: ModelClient;
  private home: string;
  private port: number;
  private storageFactory: (sessionId: string) => Storage;
  private maxRetryAttempts: number;
  private graphs = new Map<string, ThoughtGraph>();
  private queues = new Map<string, Promise<unknown>>();
  private previous = new Map<string, TurnPayload>();
  private recent = new Map<string, RecentSummary[]>();
  private sseClients = new Set<ServerResponse>();
  private server: Server | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private activeIngests = 0;

  constructor(options: DaemonOptions) {
    this.model = options.model;
    this.home = options.home ?? atlasHome();
    this.port = options.port ?? 7788;
    this.storageFactory = options.storageFactory ?? ((id) => new FsStorage(id, this.home));
    this.maxRetryAttempts = options.maxRetryAttempts ?? 5;
    if (options.retryIntervalMs !== undefined && options.retryIntervalMs > 0) {
      this.retryTimer = setInterval(() => {
        if (this.activeIngests === 0) void this.runRetryOnce();
      }, options.retryIntervalMs);
    }
  }

  private async graphFor(sessionId: string): Promise<ThoughtGraph> {
    let graph = this.graphs.get(sessionId);
    if (!graph) {
      graph = await ThoughtGraph.load(sessionId, this.storageFactory(sessionId), {
        publish: (update) => this.broadcast(update),
      });
      this.graphs.set(sessionId, graph);
    }
    return graph;
  }

  private broadcast(update: GraphUpdate): void {
    const frame = `data: ${JSON.stringify(update)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(frame);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  async ingest(payload: TurnPayload, fromRetry = false): Promise<IngestResult> {
    const prev = this.queues.get(payload.sessionId) ?? Promise.resolve();
    const run = prev.then(() => this.ingestSerial(payload, fromRetry)).catch((err) => ({
      status: 'rejected' as const,
      reason: err instanceof Error ? err.message : String(err),
    }));
    this.queues.set(payload.sessionId, run);
    return run;
  }

  private async ingestSerial(payload: TurnPayload, fromRetry: boolean): Promise<IngestResult> {
    this.activeIngests++;
    try {
      const storage = this.storageFactory(payload.sessionId);
      const graph = await this.graphFor(payload.sessionId);
      if (graph.isProcessed(payload.turnIndex)) return { status: 'duplicate' };
      await storage.appendTurn(payload);

      const prev = this.previous.get(payload.sessionId);
      const filtered = filterTurn(payload, prev);
      if (filtered.skip) {
        this.previous.set(payload.sessionId, payload);
        await graph.applyTurn(payload.turnIndex, [{ op: 'SKIP' }], payload.timestamp);
        return { status: 'skipped', reason: filtered.reason };
      }

      const result = await analyzeTurn({
        payload,
        skeleton: graph.skeleton(),
        recentSummaries: this.recent.get(payload.sessionId) ?? [],
        model: this.model,
      });
      if (!result.ok) {
        if (!fromRetry) await this.queueRetry(payload, result.reason);
        return { status: 'retry_queued', reason: result.reason };
      }
      const applied = await graph.applyTurn(payload.turnIndex, result.ops, payload.timestamp);
      if (!applied.ok) {
        if (!fromRetry) await this.queueRetry(payload, `graph rejected: ${applied.reason}`);
        return { status: 'retry_queued', reason: applied.reason };
      }
      this.previous.set(payload.sessionId, payload);
      this.updateRecent(payload.sessionId, payload.turnIndex, applied.ops ?? []);
      return { status: 'applied', opsCount: applied.ops?.length ?? 0 };
    } finally {
      this.activeIngests--;
    }
  }

  private updateRecent(sessionId: string, turnIndex: number, ops: MapOp[]): void {
    const labels = ops
      .filter((op): op is Extract<MapOp, { op: 'ADD_NODE' }> => op.op === 'ADD_NODE')
      .map((op) => op.node.label)
      .join('、');
    const list = this.recent.get(sessionId) ?? [];
    list.push({ turnIndex, summary: labels || ops.map((o) => o.op).join(',') });
    if (list.length > 2) list.shift();
    this.recent.set(sessionId, list);
  }

  private retryPath(sessionId: string): string {
    return join(this.home, 'sessions', sessionId, 'retry.jsonl');
  }

  private async queueRetry(payload: TurnPayload, reason: string): Promise<void> {
    const storage = this.storageFactory(payload.sessionId);
    await storage.appendFailure({ turnIndex: payload.turnIndex, timestamp: payload.timestamp, reason });
    const entries = await this.readRetry(payload.sessionId);
    entries.push({ payload, attempts: 1, lastError: reason, queuedAt: new Date().toISOString() });
    await writeFile(this.retryPath(payload.sessionId), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  private async readRetry(sessionId: string): Promise<RetryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.retryPath(sessionId), 'utf8');
    } catch {
      return [];
    }
    const entries: RetryEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as RetryEntry);
      } catch {
        // 损坏行丢弃
      }
    }
    return entries;
  }

  async runRetryOnce(): Promise<{ recovered: number; failed: number; exhausted: number; remaining: number }> {
    let recovered = 0;
    let failed = 0;
    let exhausted = 0;
    let remaining = 0;
    let sessionIds: string[] = [];
    try {
      sessionIds = await readdir(join(this.home, 'sessions'));
    } catch {
      return { recovered, failed, exhausted, remaining };
    }
    for (const sessionId of sessionIds) {
      if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) continue;
      const entries = await this.readRetry(sessionId);
      if (entries.length === 0) continue;
      const kept: RetryEntry[] = [];
      for (const entry of entries) {
        const result = await this.ingest(entry.payload, true);
        if (result.status === 'applied' || result.status === 'skipped' || result.status === 'duplicate') {
          recovered++;
        } else if (entry.attempts >= this.maxRetryAttempts) {
          exhausted++;
          const storage = this.storageFactory(sessionId);
          await storage.appendFailure({
            turnIndex: entry.payload.turnIndex,
            timestamp: entry.payload.timestamp,
            reason: `retry exhausted after ${entry.attempts} attempts: ${result.reason ?? ''}`,
          });
        } else {
          failed++;
          kept.push({ ...entry, attempts: entry.attempts + 1, lastError: result.reason ?? 'unknown' });
        }
      }
      remaining += kept.length;
      if (kept.length) {
        await writeFile(this.retryPath(sessionId), kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
      } else {
        await rm(this.retryPath(sessionId), { force: true });
      }
    }
    return { recovered, failed, exhausted, remaining };
  }

  async handleTurn(body: unknown): Promise<{ code: number; result: IngestResult | { error: string } }> {
    const payload = validatePayload(body);
    if (!payload) return { code: 400, result: { error: 'invalid TurnPayload' } };
    const result = await this.ingest(payload);
    return { code: 200, result };
  }

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      void this.route(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal' }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, '127.0.0.1', resolve));
    const address = this.server!.address();
    return typeof address === 'object' && address ? address.port : this.port;
  }

  private async route(req: import('node:http').IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'POST' && url.pathname === '/turn') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'body too large' }));
          return;
        }
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      const { code, result } = await this.handleTurn(body);
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      this.sseClients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(': hb\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        this.sseClients.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/map') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid sessionId' }));
        return;
      }
      const map = await this.storageFactory(sessionId).loadMap();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(map ?? { sessionId, nodes: [], edges: [], lastTurn: 0 }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}