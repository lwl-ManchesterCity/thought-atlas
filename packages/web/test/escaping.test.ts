import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(name: string): Promise<string> {
  return readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
}

test('详情面板只用 textContent 写入标签/摘要，不触碰 innerHTML', async () => {
  const panel = await source('panel.ts');
  assert.equal(panel.includes('innerHTML'), false);
  assert.ok(panel.includes('textContent'));
});

test('节点标签经 Canvas fillText 绘制（HTML 惰性）', async () => {
  const renderer = await source('renderer.ts');
  assert.ok(renderer.includes('fillText'));
  assert.equal(renderer.includes('innerHTML'), false);
});

test('数据装配层不引入 innerHTML 或 eval', async () => {
  const main = await source('main.ts');
  assert.equal(main.includes('innerHTML'), false);
  assert.equal(/\beval\s*\(/.test(main), false);
});