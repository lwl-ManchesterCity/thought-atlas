import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexWatcher } from '../src/index.ts';
import type { TurnPayload } from '@thought-atlas/core';
import { meta, turn1, turn2 } from '../../codex/test/fixtures.ts';

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function lines(records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

test('watcher delivers turns from growing rollout and never writes to watched dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-watcher-'));
  const nested = join(dir, '2026', '11', '23');
  await mkdir(nested, { recursive: true });
  const file = join(nested, 'rollout-synthetic.jsonl');
  try {
    await writeFile(file, lines([meta(), ...turn1()]));
    const before = await readFile(file, 'utf8');
    const delivered: TurnPayload[] = [];
    const watcher = new CodexWatcher({
      sessionsDir: dir,
      pollIntervalMs: 30,
      mode: 'from-start',
      deliver: async (p) => { delivered.push(p); },
    });
    await watcher.start();
    await waitFor(() => delivered.length >= 1);
    assert.equal(delivered[0].turnIndex, 1);

    await appendFile(file, lines(turn2()));
    await waitFor(() => delivered.length >= 2);
    assert.equal(delivered[1].turnIndex, 2);

    watcher.stop();
    const after = await readFile(file, 'utf8');
    assert.equal(after, before + lines(turn2()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed delivery is retried on later ticks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-watcher-'));
  const file = join(dir, 'rollout-synthetic.jsonl');
  try {
    await writeFile(file, lines([meta(), ...turn1()]));
    let attempts = 0;
    const delivered: TurnPayload[] = [];
    const watcher = new CodexWatcher({
      sessionsDir: dir,
      pollIntervalMs: 30,
      mode: 'from-start',
      deliver: async (p) => {
        attempts++;
        if (attempts === 1) throw new Error('daemon down');
        delivered.push(p);
      },
    });
    await watcher.start();
    await waitFor(() => delivered.length >= 1);
    watcher.stop();
    assert.ok(attempts >= 2);
    assert.equal(delivered[0].turnIndex, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tail mode ignores existing content and picks up only new turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-watcher-'));
  const file = join(dir, 'rollout-synthetic.jsonl');
  try {
    await writeFile(file, lines([meta(), ...turn1()]));
    const delivered: TurnPayload[] = [];
    const watcher = new CodexWatcher({
      sessionsDir: dir,
      pollIntervalMs: 30,
      mode: 'tail',
      deliver: async (p) => { delivered.push(p); },
    });
    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(delivered.length, 0);
    await appendFile(file, lines(turn2()));
    await waitFor(() => delivered.length >= 1);
    watcher.stop();
    assert.equal(delivered[0].turnIndex, 2);
    assert.ok(delivered[0].userText.includes('我之前想简单了'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});