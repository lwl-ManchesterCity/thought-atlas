import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateSamples, readApproval, scanSensitive } from '../../scripts/sample-gate.ts';

const FAKE_KEY = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0';
const CLEAN = { id: 'gold-1', file: 'gold-1.json', text: '{"synthetic":false,"turns":[{"userText":"合成占位文本"}]}' };
const SECRET = { id: 'gold-2', file: 'gold-2.json', text: JSON.stringify({ key: FAKE_KEY }) };
const PATHY = { id: 'gold-3', file: 'gold-3.json', text: '{"path":"/Users/somebody/Documents/session.jsonl"}' };

test('missing approval file falls back to synthetic only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-gate-'));
  try {
    const approval = await readApproval(join(root, 'absent.json'));
    assert.equal(approval, null);
    const result = gateSamples(approval, [CLEAN]);
    assert.equal(result.realApproved, false);
    assert.equal(result.approved.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid approval payload is rejected', () => {
  for (const bad of [null, {}, { approved: [] }, { approved: [1, 2] }]) {
    const result = gateSamples(bad, [CLEAN]);
    assert.equal(result.realApproved, false);
    assert.equal(result.approved.length, 0);
  }
});

test('sensitive hits block a sample and never echo the matched text', () => {
  const result = gateSamples({ approved: ['gold-1', 'gold-2', 'gold-3'] }, [CLEAN, SECRET, PATHY]);
  assert.equal(result.approved.length, 1);
  assert.equal(result.approved[0].id, 'gold-1');
  assert.equal(result.realApproved, true);
  const blocked = result.rejected.map((entry) => entry.id).sort();
  assert.deepEqual(blocked, ['gold-2', 'gold-3']);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('sk-A1b2'), false);
  assert.equal(serialized.includes('somebody'), false);
});

test('samples not listed in the approval file are rejected', () => {
  const result = gateSamples({ approved: [CLEAN.id] }, [SECRET]);
  assert.equal(result.realApproved, false);
  assert.equal(result.rejected[0].reason, 'not-approved');
});

test('scanSensitive reports pattern names and counts only', () => {
  const hits = scanSensitive(`联系 a@b.com 或 13800138000，路径 /Users/lwl/x，key ${FAKE_KEY}`);
  const names = hits.map((hit) => hit.name).sort();
  assert.deepEqual(names, ['absolute-home-path', 'api-key', 'cn-phone', 'email']);
  assert.equal(JSON.stringify(hits).includes('a@b.com'), false);
});

test('approved file round-trips clean candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-gate-'));
  const path = join(root, 'approvals.json');
  try {
    await writeFile(path, JSON.stringify({ approved: ['gold-1'], approvedAt: '2026-11-23T00:00:00Z' }));
    const result = gateSamples(await readApproval(path), [CLEAN]);
    assert.equal(result.realApproved, true);
    assert.equal(result.approved[0].id, 'gold-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});