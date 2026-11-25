import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionTitles, threadIdFromSessionId } from '../src/index.ts';

const THREAD_ID = '0a000000-0000-4000-8000-000000000001';
const SESSION_ID = `2026-11-20T10-00-00-${THREAD_ID}_00000000-0000-4000-8000-000000000002`;

async function withHome(files: Record<string, string>, fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'atlas-titles-'));
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(home, name), content);
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('last index row per id wins (rename semantics)', async () => {
  await withHome({
    'session_index.jsonl': [
      JSON.stringify({ id: THREAD_ID, thread_name: '合成旧名', updated_at: '2026-11-20T10:00:00Z' }),
      JSON.stringify({ id: THREAD_ID, thread_name: '合成重命名', updated_at: '2026-11-20T10:05:00Z' }),
    ].join('\n'),
  }, async (home) => {
    const titles = await readSessionTitles(home);
    assert.equal(titles.get(THREAD_ID), '合成重命名');
    assert.equal(titles.size, 1);
  });
});

test('malformed and blank-name rows are skipped', async () => {
  await withHome({
    'session_index.jsonl': [
      '{not json',
      JSON.stringify({ id: THREAD_ID, thread_name: '   ' }),
      JSON.stringify({ id: '0a000000-0000-4000-8000-000000000009', thread_name: '合成有效名' }),
      JSON.stringify({ id: 42, thread_name: '合成坏 id' }),
    ].join('\n'),
  }, async (home) => {
    const titles = await readSessionTitles(home);
    assert.equal(titles.size, 1);
    assert.equal(titles.get('0a000000-0000-4000-8000-000000000009'), '合成有效名');
  });
});

test('missing index file yields empty map', async () => {
  await withHome({}, async (home) => {
    assert.equal((await readSessionTitles(home)).size, 0);
  });
});

test('cache refreshes when index mtime changes', async () => {
  await withHome({
    'session_index.jsonl': JSON.stringify({ id: THREAD_ID, thread_name: '合成第一版' }),
  }, async (home) => {
    const path = join(home, 'session_index.jsonl');
    assert.equal((await readSessionTitles(home)).get(THREAD_ID), '合成第一版');
    await writeFile(path, JSON.stringify({ id: THREAD_ID, thread_name: '合成第二版' }));
    const future = new Date(Date.now() + 5000);
    await utimes(path, future, future);
    assert.equal((await readSessionTitles(home)).get(THREAD_ID), '合成第二版');
  });
});

test('threadIdFromSessionId matches rollout ids only', () => {
  assert.equal(threadIdFromSessionId(SESSION_ID), THREAD_ID);
  assert.equal(threadIdFromSessionId(`2026-11-20T10-00-00-${THREAD_ID}`), THREAD_ID);
  assert.equal(threadIdFromSessionId('qoder-15f08e9f-b8d8-5693-a563-afdec713e534'), null);
  assert.equal(threadIdFromSessionId('d1-synthetic-001'), null);
});