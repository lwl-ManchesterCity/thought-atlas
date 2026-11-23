import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterTurn, similarity } from '../src/index.ts';
import type { TurnPayload } from '../src/index.ts';

function turn(userText: string, assistantText: string, turnIndex = 1): TurnPayload {
  return {
    sessionId: 's1',
    turnIndex,
    userText,
    assistantText,
    timestamp: '2026-11-23T10:00:00.000Z',
    source: 'codex',
  };
}

test('combined text under 20 chars is skipped', () => {
  const result = filterTurn(turn('为什么', '因为短'));
  assert.equal(result.skip, true);
  assert.equal(result.reason, 'too-short');
});

test('pure acknowledgment is skipped', () => {
  const result = filterTurn(turn('好的，继续', '那我们接着来看下一个概念的具体细节内容'));
  assert.equal(result.skip, true);
  assert.equal(result.reason, 'ack-only');
});

test('near-duplicate of previous turn is skipped', () => {
  const prev = turn('我觉得递归比迭代更难理解，因为调用栈看不见', '递归的难点确实在于隐式调用栈，我们画个图来看每一层的压栈过程');
  const same = turn('我觉得递归比迭代更难理解，因为调用栈看不见', '递归的难点确实在于隐式调用栈，我们画个图来看每一层的压栈过程', 2);
  const result = filterTurn(same, prev);
  assert.equal(result.skip, true);
  assert.equal(result.reason, 'near-duplicate');
});

test('substantive turn passes', () => {
  const result = filterTurn(turn('我一直以为闭包就是函数套函数，它和变量生命周期到底是什么关系？', '闭包的关键是被捕获变量的生命周期被延长到了外层函数返回之后'));
  assert.equal(result.skip, false);
});

test('similarity basics', () => {
  assert.equal(similarity('完全相同的文本', '完全相同的文本'), 1);
  assert.ok(similarity('今天讨论递归', '明天讨论排序') < 0.5);
});