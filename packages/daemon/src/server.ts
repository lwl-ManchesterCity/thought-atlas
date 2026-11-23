import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile, writeFile, readdir, rm, stat, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ThoughtGraph,
  filterTurn,
  analyzeTurn,
  computeClusters,
  foldEvents,
  MANUAL_TURN_BASE,
} from '@thought-atlas/core';
import type {
  TurnPayload,
  ModelClient,
  Storage,
  GraphUpdate,
  GraphMap,
  RecentSummary,
  SourcePlatform,
  MapOp,
  ThoughtNode,
} from '@thought-atlas/core';
import { FsStorage, atlasHome } from './fs-storage.ts';
import { nameClusters, type ClusterNamingGroup } from './cluster-namer.ts';

export interface DaemonOptions {
  model: ModelClient;
  home?: string;
  port?: number;
  storageFactory?: (sessionId: string) => Storage;
  retryIntervalMs?: number;
  maxRetryAttempts?: number;
  webDir?: string;
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

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

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

const SESSION_RE = /^[A-Za-z0-9._-]+$/;
const NODE_RE = /^[A-Za-z0-9._-]+$/;
const ANCHOR_TEXT_MAX = 8000;

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

interface NamedCluster {
  label: string;
  labelsHash: string;
  source: 'model' | 'fallback';
  namedAt: string;
}

interface ClusterCache {
  lastActive: number;
  names: Map<string, NamedCluster>;
}

interface ClusterViewItem {
  key: string;
  index: number;
  label: string;
  nodeIds: string[];
  size: number;
  named: boolean;
}

interface ClusterView {
  sessionId: string;
  activeCount: number;
  clusters: ClusterViewItem[];
  isolated: string[];
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function emptyMap(sessionId: string): GraphMap {
  return { sessionId, nodes: [], edges: [], lastTurn: 0 };
}

function clampText(text: string): string {
  return text.length <= ANCHOR_TEXT_MAX ? text : text.slice(0, ANCHOR_TEXT_MAX) + '…';
}

export class AtlasDaemon {
  private model: ModelClient;
  private home: string;
  private port: number;
  private storageFactory: (sessionId: string) => Storage;
  private maxRetryAttempts: number;
  private webDir: string | null;
  private graphs = new Map<string, ThoughtGraph>();
  private queues = new Map<string, Promise<unknown>>();
  private previous = new Map<string, TurnPayload>();
  private recent = new Map<string, RecentSummary[]>();
  private sseClients = new Set<ServerResponse>();
  private clusterCaches = new Map<string, ClusterCache>();
  private namingSessions = new Set<string>();
  private server: Server | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private activeIngests = 0;

  constructor(options: DaemonOptions) {
    this.model = options.model;
    this.home = options.home ?? atlasHome();
    this.port = options.port ?? 7788;
    this.storageFactory = options.storageFactory ?? ((id) => new FsStorage(id, this.home));
    this.maxRetryAttempts = options.maxRetryAttempts ?? 5;
    this.webDir = options.webDir ?? null;
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
      this.maybeNameClusters(payload.sessionId, graph);
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

  private async readJsonBody(req: import('node:http').IncomingMessage, res: ServerResponse): Promise<unknown | null> {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        sendJson(res, 413, { error: 'body too large' });
        return null;
      }
    }
    try {
      return JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON' });
      return null;
    }
  }

  private async readTurns(sessionId: string): Promise<TurnPayload[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.home, 'sessions', sessionId, 'turns.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const turns: TurnPayload[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        turns.push(JSON.parse(line) as TurnPayload);
      } catch {
        break;
      }
    }
    return turns;
  }

  private clusterCachePath(sessionId: string): string {
    return join(this.home, 'sessions', sessionId, 'cluster-names.json');
  }

  private async loadClusterCache(sessionId: string): Promise<ClusterCache> {
    const cached = this.clusterCaches.get(sessionId);
    if (cached) return cached;
    const cache: ClusterCache = { lastActive: 0, names: new Map() };
    try {
      const raw = JSON.parse(await readFile(this.clusterCachePath(sessionId), 'utf8')) as {
        lastActive?: unknown;
        names?: Record<string, { label?: unknown; labelsHash?: unknown; source?: unknown; namedAt?: unknown }>;
      };
      if (typeof raw.lastActive === 'number' && Number.isFinite(raw.lastActive)) cache.lastActive = raw.lastActive;
      if (raw.names && typeof raw.names === 'object') {
        for (const [key, entry] of Object.entries(raw.names)) {
          if (!entry || typeof entry.label !== 'string' || typeof entry.labelsHash !== 'string') continue;
          cache.names.set(key, {
            label: entry.label,
            labelsHash: entry.labelsHash,
            source: entry.source === 'fallback' ? 'fallback' : 'model',
            namedAt: typeof entry.namedAt === 'string' ? entry.namedAt : '',
          });
        }
      }
    } catch {
      // 缓存缺失或损坏时从空缓存起步
    }
    this.clusterCaches.set(sessionId, cache);
    return cache;
  }

  private async saveClusterCache(sessionId: string, cache: ClusterCache): Promise<void> {
    const dir = join(this.home, 'sessions', sessionId);
    await mkdir(dir, { recursive: true });
    const target = this.clusterCachePath(sessionId);
    const tmp = target + '.tmp';
    const names: Record<string, NamedCluster> = {};
    for (const [key, entry] of cache.names) names[key] = entry;
    await writeFile(tmp, JSON.stringify({ lastActive: cache.lastActive, names }, null, 2));
    await rename(tmp, target);
  }

  private buildClusterView(sessionId: string, map: GraphMap, cache: ClusterCache): ClusterView {
    const snapshot = computeClusters(map);
    const byId = new Map(map.nodes.map((node) => [node.id, node]));
    const activeCount = map.nodes.filter((node) => node.status === 'active').length;
    const clusters = snapshot.clusters.map((group) => {
      const labels = group.nodeIds
        .map((id) => byId.get(id)?.label)
        .filter((label): label is string => typeof label === 'string' && label.length > 0)
        .slice(0, 12);
      const labelsHash = hashText(labels.join('|'));
      const entry = cache.names.get(group.key);
      const named = !!entry && entry.labelsHash === labelsHash;
      return {
        key: group.key,
        index: group.index,
        label: named ? entry.label : `簇 #${group.index}`,
        nodeIds: group.nodeIds,
        size: group.nodeIds.length,
        named,
      };
    });
    return { sessionId, activeCount, clusters, isolated: snapshot.isolated };
  }

  private async runClusterNaming(sessionId: string, map: GraphMap, force: boolean): Promise<ClusterView> {
    const cache = await this.loadClusterCache(sessionId);
    const snapshot = computeClusters(map);
    const byId = new Map(map.nodes.map((node) => [node.id, node]));
    const groups = snapshot.clusters.map((group) => {
      const labels = group.nodeIds
        .map((id) => byId.get(id)?.label)
        .filter((label): label is string => typeof label === 'string' && label.length > 0)
        .slice(0, 12);
      return { group, labels, labelsHash: hashText(labels.join('|')) };
    });
    const needs = groups
      .filter((item) => {
        if (!force && item.labels.length === 0) return false;
        const entry = cache.names.get(item.group.key);
        return force || !entry || entry.labelsHash !== item.labelsHash;
      })
      .slice(0, force ? 20 : 8);
    if (needs.length > 0) {
      const namingGroups: ClusterNamingGroup[] = needs.map((item) => ({
        key: item.group.key,
        index: item.group.index,
        labels: item.labels,
      }));
      try {
        const result = await nameClusters(this.model, namingGroups);
        if (result.ok) {
          const namedAt = new Date().toISOString();
          for (const item of needs) {
            const label = result.names.get(item.group.key);
            if (!label) continue;
            cache.names.set(item.group.key, {
              label,
              labelsHash: item.labelsHash,
              source: 'model',
              namedAt,
            });
          }
        }
      } catch {
        // 模型不可用时保留 fallback 标签，不阻塞渲染
      }
    }
    cache.lastActive = map.nodes.filter((node) => node.status === 'active').length;
    await this.saveClusterCache(sessionId, cache);
    return this.buildClusterView(sessionId, map, cache);
  }

  private async refreshClusterNames(sessionId: string, map: GraphMap, force: boolean): Promise<ClusterView> {
    if (this.namingSessions.has(sessionId)) {
      const cache = await this.loadClusterCache(sessionId);
      return this.buildClusterView(sessionId, map, cache);
    }
    this.namingSessions.add(sessionId);
    try {
      return await this.runClusterNaming(sessionId, map, force);
    } finally {
      this.namingSessions.delete(sessionId);
    }
  }

  private maybeNameClusters(sessionId: string, graph: ThoughtGraph): void {
    const map = graph.getMap();
    const activeCount = map.nodes.filter((node) => node.status === 'active').length;
    void (async () => {
      try {
        const cache = await this.loadClusterCache(sessionId);
        if (activeCount - cache.lastActive < 10) return;
        cache.lastActive = activeCount;
        await this.saveClusterCache(sessionId, cache);
        await this.refreshClusterNames(sessionId, map, false);
      } catch {
        // 命名是增强能力，失败不影响 ingest
      }
    })();
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
      const body = await this.readJsonBody(req, res);
      if (body === null) return;
      const { code, result } = await this.handleTurn(body);
      sendJson(res, code, result);
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
      if (!SESSION_RE.test(sessionId)) {
        sendJson(res, 400, { error: 'invalid sessionId' });
        return;
      }
      const map = await this.storageFactory(sessionId).loadMap();
      sendJson(res, 200, map ?? emptyMap(sessionId));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/replay') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (!SESSION_RE.test(sessionId)) {
        sendJson(res, 400, { error: 'invalid sessionId' });
        return;
      }
      const storage = this.storageFactory(sessionId);
      const [events, map] = await Promise.all([storage.loadEvents(), storage.loadMap()]);
      const steps = events.map((event) => ({
        turnIndex: event.turnIndex,
        timestamp: event.timestamp,
        manual: event.turnIndex >= MANUAL_TURN_BASE,
        opsCount: event.ops.length,
      }));
      sendJson(res, 200, { sessionId, lastTurn: map?.lastTurn ?? 0, steps, events });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/replay/snapshot') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (!SESSION_RE.test(sessionId)) {
        sendJson(res, 400, { error: 'invalid sessionId' });
        return;
      }
      let upToTurn = Number.POSITIVE_INFINITY;
      const rawTurn = url.searchParams.get('turn');
      if (rawTurn !== null) {
        const turn = Number(rawTurn);
        if (!Number.isInteger(turn) || turn < 1 || turn > 1_000_000_000) {
          sendJson(res, 400, { error: 'invalid turn' });
          return;
        }
        upToTurn = turn;
      }
      const events = await this.storageFactory(sessionId).loadEvents();
      let map: GraphMap;
      try {
        map = foldEvents(sessionId, events, upToTurn);
      } catch (err) {
        sendJson(res, 500, { error: 'replay fold failed', detail: err instanceof Error ? err.message : String(err) });
        return;
      }
      sendJson(res, 200, { sessionId, snapshotTurn: Number.isFinite(upToTurn) ? upToTurn : null, map });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/clusters') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (!SESSION_RE.test(sessionId)) {
        sendJson(res, 400, { error: 'invalid sessionId' });
        return;
      }
      const map = (await this.storageFactory(sessionId).loadMap()) ?? emptyMap(sessionId);
      const cache = await this.loadClusterCache(sessionId);
      sendJson(res, 200, this.buildClusterView(sessionId, map, cache));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/clusters/refresh') {
      const body = await this.readJsonBody(req, res);
      if (body === null) return;
      const sessionId =
        typeof body === 'object' && body !== null && typeof (body as { sessionId?: unknown }).sessionId === 'string'
          ? (body as { sessionId: string }).sessionId
          : '';
      if (!SESSION_RE.test(sessionId)) {
        sendJson(res, 400, { error: 'invalid sessionId' });
        return;
      }
      const map = (await this.storageFactory(sessionId).loadMap()) ?? emptyMap(sessionId);
      const view = await this.refreshClusterNames(sessionId, map, true);
      sendJson(res, 200, view);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/anchors') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const nodeId = url.searchParams.get('nodeId') ?? '';
      if (!SESSION_RE.test(sessionId) || !NODE_RE.test(nodeId)) {
        sendJson(res, 400, { error: 'invalid sessionId or nodeId' });
        return;
      }
      let wanted: number[] | null = null;
      const rawTurns = url.searchParams.get('turns');
      if (rawTurns) {
        const parts = rawTurns.split(',').map((p) => Number(p.trim()));
        if (parts.some((n) => !Number.isInteger(n) || n < 1 || n > 1_000_000_000)) {
          sendJson(res, 400, { error: 'invalid turns' });
          return;
        }
        wanted = [...new Set(parts)];
      }
      const map = await this.storageFactory(sessionId).loadMap();
      const node = map?.nodes.find((n) => n.id === nodeId) ?? null;
      const anchorTurns = [...new Set(wanted ?? node?.anchorTurns ?? [])].sort((a, b) => a - b).slice(0, 50);
      const allTurns = await this.readTurns(sessionId);
      const byTurn = new Map(allTurns.map((turn) => [turn.turnIndex, turn]));
      const turns = anchorTurns.flatMap((turnIndex) => {
        const turn = byTurn.get(turnIndex);
        if (!turn) return [];
        return [
          {
            turnIndex,
            timestamp: turn.timestamp,
            userText: clampText(turn.userText),
            assistantText: clampText(turn.assistantText),
          },
        ];
      });
      sendJson(res, 200, { sessionId, nodeId, found: !!node, anchorTurns: turns.map((t) => t.turnIndex), turns });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/manual') {
      const body = await this.readJsonBody(req, res);
      if (body === null) return;
      const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
      const nodeId = typeof record.nodeId === 'string' ? record.nodeId : '';
      const action = record.action;
      if (!SESSION_RE.test(sessionId) || !NODE_RE.test(nodeId) || (action !== 'mark-shift' && action !== 'delete')) {
        sendJson(res, 400, { error: 'invalid manual request' });
        return;
      }
      const graph = await this.graphFor(sessionId);
      const node: ThoughtNode | undefined = graph.getMap().nodes.find((n) => n.id === nodeId);
      if (!node) {
        sendJson(res, 404, { error: 'unknown node' });
        return;
      }
      let op: MapOp;
      if (action === 'mark-shift') {
        if (node.type === 'ai-voice') {
          sendJson(res, 409, { error: 'cannot mark ai-voice as shift' });
          return;
        }
        if (node.status !== 'active') {
          sendJson(res, 409, { error: `node is not active (${node.status})` });
          return;
        }
        op = {
          op: 'MARK_SHIFT',
          nodeId,
          shift: { toSummary: node.summary || node.label, fromNodeId: null, triggerNodeId: null, retro: false },
          manual: true,
        };
      } else {
        op = { op: 'DELETE', nodeId };
      }
      const applied = await graph.applyManual([op], new Date().toISOString());
      if (!applied.ok) {
        sendJson(res, 409, { error: applied.reason ?? 'manual op rejected' });
        return;
      }
      sendJson(res, 200, {
        status: 'applied',
        action,
        nodeId,
        turnIndex: applied.turnIndex,
        manual: true,
        map: graph.getMap(),
      });
      return;
    }

    const staticEntry = STATIC_FILES[url.pathname];
    if (req.method === 'GET' && staticEntry) {
      if (!this.webDir) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'web build not available' }));
        return;
      }
      try {
        const content = await readFile(join(this.webDir, staticEntry.file));
        res.writeHead(200, { 'Content-Type': staticEntry.type, 'Cache-Control': 'no-cache' });
        res.end(content);
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      const sessions = await this.listSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
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

  private async listSessions(): Promise<
    { sessionId: string; lastTurn: number; nodes: number; edges: number; updatedAt: string }[]
  > {
    const dir = join(this.home, 'sessions');
    let ids: string[] = [];
    try {
      ids = await readdir(dir);
    } catch {
      return [];
    }
    const sessions: {
      sessionId: string;
      lastTurn: number;
      nodes: number;
      edges: number;
      updatedAt: string;
    }[] = [];
    for (const id of ids) {
      if (!/^[A-Za-z0-9._-]+$/.test(id)) continue;
      try {
        const path = join(dir, id, 'map.json');
        const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
        const map = JSON.parse(raw) as GraphMap;
        sessions.push({
          sessionId: id,
          lastTurn: map.lastTurn ?? 0,
          nodes: map.nodes?.length ?? 0,
          edges: map.edges?.length ?? 0,
          updatedAt: info.mtime.toISOString(),
        });
      } catch {
        continue;
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions;
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}