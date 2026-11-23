import { ThoughtGraph, analyzeTurn } from './core/index.ts';
import type { GraphMap, MapOp, TurnPayload } from './core/types.ts';
import { DbStorage } from './db-storage.ts';
import type { DbClient } from './db.ts';
import { insertRow, rows } from './db.ts';
import { AppError, errorResponse, publicMessage } from './errors.ts';
import type { HostedModel } from './model.ts';
import { HOSTED_MODEL } from './model.ts';
import {
  LIMITS,
  cacheKey,
  countSessionsToday,
  hashIp,
  readCache,
  readDailyUsage,
  reserveDailyAnalysis,
  reserveSessionTurn,
  utcDay,
  writeCache,
  type SessionRow,
} from './limits.ts';
import { rebindTurnFields } from './ops.ts';

export interface HostedDeps {
  db: DbClient;
  model: HostedModel | null;
  now?: () => Date;
  clientIp?: (request: Request) => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function defaultIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw new AppError('invalid_json', 400);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('invalid_json', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.maxBodyBytes) throw new AppError('payload_too_large', 413);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError('invalid_json', 400);
  }
}

function textLength(text: string): number {
  return [...text].length;
}

function emptyMap(sessionId: string): GraphMap {
  return { sessionId, nodes: [], edges: [], lastTurn: 0 };
}

function sessionLimits(session: SessionRow, analysesUsed: number) {
  return {
    turnsPerSession: LIMITS.turnsPerSession,
    sessionTurnsRemaining: Math.max(0, LIMITS.turnsPerSession - session.last_turn),
    analysesPerDay: LIMITS.analysesPerDay,
    analysesRemaining: Math.max(0, LIMITS.analysesPerDay - analysesUsed),
  };
}

export function application(deps: HostedDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const ipOf = deps.clientIp ?? defaultIp;
  const db = deps.db;

  async function loadSession(id: string, ipHash: string): Promise<SessionRow> {
    const found = await rows<SessionRow>(
      db
        .from('sandbox_sessions')
        .select('id,ip_hash,day,last_turn,created_at,updated_at')
        .eq('id', id)
        .limit(1),
    );
    if (!found.length) throw new AppError('not_found', 404);
    if (found[0].ip_hash !== ipHash) throw new AppError('forbidden', 403);
    return found[0];
  }

  async function reserveTurn(id: string, ipHash: string): Promise<{ session: SessionRow; turnIndex: number }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const session = await loadSession(id, ipHash);
      if (session.last_turn >= LIMITS.turnsPerSession) {
        throw new AppError('session_turn_limit', 429);
      }
      const turnIndex = await reserveSessionTurn(db, session, now());
      if (turnIndex !== null) return { session: { ...session, last_turn: turnIndex }, turnIndex };
    }
    throw new AppError('session_busy', 409);
  }

  async function recordTurn(
    sessionId: string,
    turnIndex: number,
    inputHash: string,
    skelHash: string,
    status: string,
  ): Promise<void> {
    await insertRow(db, 'sandbox_turns', {
      id: crypto.randomUUID(),
      session_id: sessionId,
      turn_index: turnIndex,
      input_hash: inputHash,
      skeleton_hash: skelHash,
      status,
      created_at: now().toISOString(),
    });
  }

  async function turn(request: Request): Promise<Response> {
    const body = await readJson(request);
    const sessionId = body.sessionId;
    const text = body.text;
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) throw new AppError('invalid_input', 400);
    if (typeof text !== 'string' || !text.trim()) throw new AppError('invalid_input', 400);
    if (textLength(text) > LIMITS.maxInputChars) throw new AppError('text_too_long', 400);

    const ipHash = await hashIp(ipOf(request));
    const session = await loadSession(sessionId, ipHash);
    if (session.last_turn >= LIMITS.turnsPerSession) throw new AppError('session_turn_limit', 429);

    const storage = new DbStorage(db, sessionId);
    const graph = await ThoughtGraph.load(sessionId, storage);
    const skeleton = graph.skeleton();
    const key = await cacheKey(text, skeleton);
    const cached = await readCache(db, key.key);
    const cachedOps = cached && Array.isArray(cached.ops) && Number.isInteger(cached.source_turn)
      ? (cached.ops as MapOp[])
      : null;

    if (cachedOps) {
      const reserved = await reserveTurn(sessionId, ipHash);
      const ts = now().toISOString();
      const ops = rebindTurnFields(cachedOps, cached!.source_turn, reserved.turnIndex);
      const applied = await graph.applyTurn(reserved.turnIndex, ops, ts);
      if (!applied.ok) {
        await recordTurn(sessionId, reserved.turnIndex, key.inputHash, key.skeletonHash, 'analysis_failed');
        return json({
          sessionId,
          turnIndex: reserved.turnIndex,
          reply: '相同输入的分析缓存已失效，本轮未再调用模型。',
          status: 'analysis_failed',
          notice: publicMessage('analysis_failed'),
          map: graph.getMap(),
          analysis: { modelUsed: false, cached: true, opsCount: 0 },
          limits: sessionLimits(reserved.session, await readDailyUsage(db, utcDay(now()))),
        });
      }
      await recordTurn(sessionId, reserved.turnIndex, key.inputHash, key.skeletonHash, 'cache_hit');
      const used = await readDailyUsage(db, utcDay(now()));
      return json({
        sessionId,
        turnIndex: reserved.turnIndex,
        reply: '相同输入已命中缓存，直接复用上次的分析结果；本轮不再调用模型。',
        status: 'cache_hit',
        map: graph.getMap(),
        analysis: { modelUsed: false, cached: true, opsCount: applied.ops?.length ?? 0 },
        limits: sessionLimits(reserved.session, used),
      });
    }

    if (!deps.model) throw new AppError('service_not_configured', 503);
    const quota = await reserveDailyAnalysis(db, utcDay(now()), now());
    if (!quota.ok) throw new AppError('quota_exhausted', 429);

    const reserved = await reserveTurn(sessionId, ipHash);
    const ts = now().toISOString();
    const labels = skeleton.slice(-12).map((node) => node.label);
    const chat = await deps.model.chat(text, labels);
    const payload: TurnPayload = {
      sessionId,
      turnIndex: reserved.turnIndex,
      userText: text,
      assistantText: chat.text,
      timestamp: ts,
      source: 'sandbox',
    };
    const analyzed = await analyzeTurn({ payload, skeleton, recentSummaries: [], model: deps.model });
    if (!analyzed.ok) {
      await storage.appendFailure({
        turnIndex: reserved.turnIndex,
        timestamp: ts,
        reason: analyzed.reason,
      });
      await recordTurn(sessionId, reserved.turnIndex, key.inputHash, key.skeletonHash, 'analysis_failed');
      return json({
        sessionId,
        turnIndex: reserved.turnIndex,
        reply: chat.text,
        status: 'analysis_failed',
        notice: publicMessage('analysis_failed'),
        map: graph.getMap(),
        analysis: { modelUsed: true, cached: false, opsCount: 0 },
        limits: sessionLimits(reserved.session, quota.used),
      });
    }

    const applied = await graph.applyTurn(reserved.turnIndex, analyzed.ops, ts);
    if (!applied.ok) {
      await recordTurn(sessionId, reserved.turnIndex, key.inputHash, key.skeletonHash, 'analysis_failed');
      return json({
        sessionId,
        turnIndex: reserved.turnIndex,
        reply: chat.text,
        status: 'analysis_failed',
        notice: publicMessage('analysis_failed'),
        map: graph.getMap(),
        analysis: { modelUsed: true, cached: false, opsCount: 0 },
        limits: sessionLimits(reserved.session, quota.used),
      });
    }

    try {
      await writeCache(db, key.key, analyzed.ops, reserved.turnIndex, now());
    } catch {
      // 缓存失败不阻断本轮；下一轮最多再调一次模型
    }
    const status = applied.ops?.every((op) => op.op === 'SKIP') ? 'skipped' : 'applied';
    await recordTurn(sessionId, reserved.turnIndex, key.inputHash, key.skeletonHash, status);
    return json({
      sessionId,
      turnIndex: reserved.turnIndex,
      reply: chat.text,
      status,
      map: graph.getMap(),
      analysis: { modelUsed: true, cached: false, opsCount: applied.ops?.length ?? 0 },
      limits: sessionLimits(reserved.session, quota.used),
    });
  }

  async function createSession(request: Request): Promise<Response> {
    const ipHash = await hashIp(ipOf(request));
    const day = utcDay(now());
    const count = await countSessionsToday(db, ipHash, day);
    if (count >= LIMITS.sessionsPerIpPerDay) throw new AppError('session_limit', 429);
    const id = crypto.randomUUID();
    const stamp = now().toISOString();
    await insertRow(db, 'sandbox_sessions', {
      id,
      ip_hash: ipHash,
      day,
      last_turn: 0,
      created_at: stamp,
      updated_at: stamp,
    });
    return json({
      sessionId: id,
      limits: {
        sessionsPerIpPerDay: LIMITS.sessionsPerIpPerDay,
        sessionsRemaining: Math.max(0, LIMITS.sessionsPerIpPerDay - count - 1),
        turnsPerSession: LIMITS.turnsPerSession,
        analysesPerDay: LIMITS.analysesPerDay,
      },
    }, 201);
  }

  async function getSession(request: Request, url: URL): Promise<Response> {
    const id = url.searchParams.get('id') ?? '';
    if (!UUID_RE.test(id)) throw new AppError('invalid_input', 400);
    const ipHash = await hashIp(ipOf(request));
    const session = await loadSession(id, ipHash);
    const storage = new DbStorage(db, id);
    const graph = await ThoughtGraph.load(id, storage);
    const used = await readDailyUsage(db, utcDay(now()));
    return json({
      sessionId: id,
      map: graph.getMap() ?? emptyMap(id),
      lastTurn: session.last_turn,
      limits: sessionLimits(session, used),
    });
  }

  async function selfcheck(): Promise<Response> {
    if (!deps.model) {
      return json({ configured: false, reachable: false, model: HOSTED_MODEL });
    }
    const quota = await reserveDailyAnalysis(db, utcDay(now()), now());
    if (!quota.ok) {
      return json({ configured: true, reachable: null, reason: 'quota_exhausted', model: HOSTED_MODEL });
    }
    const result = await deps.model.selfcheck();
    return json({
      configured: true,
      reachable: result.ok,
      latencyMs: result.latencyMs,
      model: HOSTED_MODEL,
    });
  }

  return async (request) => {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
      if (!match) throw new AppError('not_found', 404);
      const path = match[1] || '/';

      if (path === '/api/health' && request.method === 'GET') {
        return json({ ok: true, configured: deps.model !== null, model: HOSTED_MODEL });
      }
      if (path === '/api/selfcheck' && request.method === 'POST') {
        return await selfcheck();
      }
      if (path === '/api/sandbox/session' && request.method === 'POST') {
        return await createSession(request);
      }
      if (path === '/api/sandbox/session' && request.method === 'GET') {
        return await getSession(request, url);
      }
      if (path === '/api/sandbox/turn' && request.method === 'POST') {
        return await turn(request);
      }
      throw new AppError('not_found', 404);
    } catch (error) {
      return errorResponse(error);
    }
  };
}