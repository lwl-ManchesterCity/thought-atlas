import type { SkeletonNode } from './core/types.ts';
import type { DbClient } from './db.ts';
import { insertRow, rows, updateRows } from './db.ts';
import { AppError } from './errors.ts';

export const LIMITS = {
  sessionsPerIpPerDay: 2,
  turnsPerSession: 15,
  analysesPerDay: 100,
  maxInputChars: 2000,
  maxBodyBytes: 8192,
  cacheVersion: 'analyzer-v1',
};

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashIp(ip: string): Promise<string> {
  return sha256Hex(`thought-atlas-sandbox|${ip}`);
}

export function normalizeInput(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function skeletonHash(skeleton: SkeletonNode[]): Promise<string> {
  const stable = [...skeleton]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => [n.id, n.type, n.label, n.summary, n.lastTurn]);
  return sha256Hex(JSON.stringify(stable));
}

export async function cacheKey(userText: string, skeleton: SkeletonNode[]): Promise<{ key: string; inputHash: string; skeletonHash: string; normalized: string }> {
  const normalized = normalizeInput(userText);
  const inputHash = await sha256Hex(normalized);
  const skelHash = await skeletonHash(skeleton);
  const key = await sha256Hex(`${LIMITS.cacheVersion}\n${inputHash}\n${skelHash}`);
  return { key, inputHash, skeletonHash: skelHash, normalized };
}

export async function countSessionsToday(db: DbClient, ipHash: string, day: string): Promise<number> {
  const found = await rows(
    db
      .from('sandbox_sessions')
      .select('id')
      .eq('ip_hash', ipHash)
      .eq('day', day)
      .limit(LIMITS.sessionsPerIpPerDay + 1),
  );
  return found.length;
}

export interface DailyUsage {
  ok: boolean;
  used: number;
}

export async function reserveDailyAnalysis(db: DbClient, day: string, now: Date): Promise<DailyUsage> {
  const stamp = now.toISOString();
  for (let attempt = 0; attempt < 6; attempt++) {
    const found = await rows<{ model_calls: number }>(
      db.from('daily_counters').select('model_calls').eq('day', day).limit(1),
    );
    if (!found.length) {
      try {
        await insertRow(db, 'daily_counters', { day, model_calls: 1, updated_at: stamp });
        return { ok: true, used: 1 };
      } catch {
        continue;
      }
    }
    const used = found[0].model_calls;
    if (!Number.isSafeInteger(used) || used < 0) throw new AppError('database_unavailable', 503);
    if (used >= LIMITS.analysesPerDay) return { ok: false, used };
    const updated = await updateRows(
      db,
      'daily_counters',
      { model_calls: used + 1, updated_at: stamp },
      { day, model_calls: used },
    );
    if (updated.length) return { ok: true, used: used + 1 };
  }
  throw new AppError('database_unavailable', 503);
}

export async function readDailyUsage(db: DbClient, day: string): Promise<number> {
  const found = await rows<{ model_calls: number }>(
    db.from('daily_counters').select('model_calls').eq('day', day).limit(1),
  );
  return found[0]?.model_calls ?? 0;
}

export interface SessionRow {
  id: string;
  ip_hash: string;
  day: string;
  last_turn: number;
  created_at: string;
  updated_at: string;
}

export async function reserveSessionTurn(
  db: DbClient,
  session: SessionRow,
  now: Date,
): Promise<number | null> {
  const next = session.last_turn + 1;
  const updated = await updateRows(
    db,
    'sandbox_sessions',
    { last_turn: next, updated_at: now.toISOString() },
    { id: session.id, ip_hash: session.ip_hash, last_turn: session.last_turn },
  );
  return updated.length ? next : null;
}

export interface CachedTurn {
  ops: unknown;
  source_turn: number;
}

export async function readCache(db: DbClient, key: string): Promise<CachedTurn | null> {
  const found = await rows<CachedTurn>(
    db
      .from('analysis_cache')
      .select('ops,source_turn')
      .eq('cache_key', key)
      .limit(1),
  );
  return found[0] ?? null;
}

export async function writeCache(
  db: DbClient,
  key: string,
  ops: unknown,
  sourceTurn: number,
  now: Date,
): Promise<void> {
  await insertRow(db, 'analysis_cache', {
    cache_key: key,
    ops,
    source_turn: sourceTurn,
    created_at: now.toISOString(),
  });
}