import { readFile } from 'node:fs/promises';

export interface RealSampleCandidate {
  id: string;
  file: string;
  text: string;
}

export interface ApprovalFile {
  approved: string[];
  approvedAt?: string;
  note?: string;
}

export interface SampleGateResult {
  realApproved: boolean;
  reason: 'approved' | 'approval-missing' | 'approval-invalid' | 'no-approved-candidates';
  approved: RealSampleCandidate[];
  rejected: { id: string; reason: string; patterns: string[] }[];
}

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'absolute-home-path', re: /\/Users\/[^/\s"']+/g },
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: 'cn-phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { name: 'qoder-home', re: /\.(?:codex|qoder-cn)\b/g },
];

/** 只返回命中的模式名与次数，绝不回显命中的原文。 */
export function scanSensitive(text: string): { name: string; count: number }[] {
  const hits: { name: string; count: number }[] = [];
  for (const { name, re } of PATTERNS) {
    const count = [...text.matchAll(re)].length;
    if (count > 0) hits.push({ name, count });
  }
  return hits;
}

export function gateSamples(approval: unknown, candidates: RealSampleCandidate[]): SampleGateResult {
  const parsed = parseApproval(approval);
  if (!parsed) {
    return {
      realApproved: false,
      reason: 'approval-invalid',
      approved: [],
      rejected: candidates.map((c) => ({ id: c.id, reason: 'approval-invalid', patterns: [] })),
    };
  }
  const approvedIds = new Set(parsed.approved);
  const approved: RealSampleCandidate[] = [];
  const rejected: SampleGateResult['rejected'] = [];
  for (const candidate of candidates) {
    if (!approvedIds.has(candidate.id)) {
      rejected.push({ id: candidate.id, reason: 'not-approved', patterns: [] });
      continue;
    }
    const hits = scanSensitive(candidate.text);
    if (hits.length) {
      rejected.push({ id: candidate.id, reason: 'sensitive-hit', patterns: hits.map((h) => h.name) });
      continue;
    }
    approved.push(candidate);
  }
  if (!approved.length) {
    return { realApproved: false, reason: 'no-approved-candidates', approved, rejected };
  }
  return { realApproved: true, reason: 'approved', approved, rejected };
}

export function parseApproval(value: unknown): ApprovalFile | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.approved)) return null;
  const approved = v.approved.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (!approved.length) return null;
  return {
    approved,
    approvedAt: typeof v.approvedAt === 'string' ? v.approvedAt : undefined,
    note: typeof v.note === 'string' ? v.note : undefined,
  };
}

export async function readApproval(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}