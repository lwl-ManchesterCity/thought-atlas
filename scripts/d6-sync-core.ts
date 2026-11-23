import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'packages/core/src');
const DEST = join(ROOT, 'site/functions/lib/core');
const CHECK = process.argv.includes('--check');

const files = (await readdir(SRC)).filter((name) => name.endsWith('.ts')).sort();
if (files.length === 0) throw new Error('core source is empty');
const mismatched: string[] = [];

await mkdir(DEST, { recursive: true });
for (const name of files) {
  const source = await readFile(join(SRC, name), 'utf8');
  const target = join(DEST, name);
  let current: string | null = null;
  try {
    current = await readFile(target, 'utf8');
  } catch {
    current = null;
  }
  if (current !== source) {
    if (CHECK) mismatched.push(name);
    else await writeFile(target, source);
  }
}

if (CHECK) {
  if (mismatched.length) {
    throw new Error(`vendor core out of sync: ${mismatched.join(', ')} (run npm run sync:core)`);
  }
  console.log(`core vendor in sync (${files.length} files)`);
} else {
  console.log(`core vendor synced (${files.length} files) -> site/functions/lib/core`);
}