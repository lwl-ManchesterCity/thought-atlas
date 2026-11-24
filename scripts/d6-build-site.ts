import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { gateSamples, readApproval, type RealSampleCandidate } from './sample-gate.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SITE = join(ROOT, 'site');
const DIST = join(SITE, 'dist');
const APPROVAL = join(homedir(), '.thought-atlas', 'sample-approvals.json');

execFileSync(process.execPath, [join(ROOT, 'scripts/d6-sync-core.ts'), '--check'], { stdio: 'inherit' });

await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, 'assets'), { recursive: true });
await mkdir(join(DIST, 'samples'), { recursive: true });

for (const file of ['index.html', 'demo.html', 'sandbox.html', 'install.html', 'boundary.html', 'site.css', 'favicon.svg', 'og.png']) {
  await copyFile(join(SITE, 'web', file), join(DIST, file));
}

await build({
  entryPoints: {
    home: join(SITE, 'web', 'home.ts'),
    demo: join(SITE, 'web', 'demo.ts'),
    sandbox: join(SITE, 'web', 'sandbox.ts'),
  },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  outdir: join(DIST, 'assets'),
  alias: { '@thought-atlas/core': join(SITE, 'functions', 'lib', 'core', 'index.ts') },
  logLevel: 'info',
});

const syntheticManifest = JSON.parse(await readFile(join(SITE, 'samples', 'manifest.json'), 'utf8')) as {
  synthetic: boolean;
  notice: string;
  generatedAt: string;
  realSamplesApproved: boolean;
  sessions: { file: string; id: string; title: string; summary: string; stats: unknown }[];
};

for (const session of syntheticManifest.sessions) {
  await copyFile(join(SITE, 'samples', session.file), join(DIST, 'samples', session.file));
}

const candidates: RealSampleCandidate[] = [];
try {
  const names = (await readdir(join(SITE, 'samples', 'real'))).filter((name) => name.endsWith('.json'));
  for (const name of names) {
    const file = join(SITE, 'samples', 'real', name);
    candidates.push({ id: basename(name, '.json'), file: name, text: await readFile(file, 'utf8') });
  }
} catch {
  // 未填充真实样例目录是默认状态
}

const gate = gateSamples(await readApproval(APPROVAL), candidates);
const manifest = structuredClone(syntheticManifest);
manifest.realSamplesApproved = gate.realApproved;
manifest.synthetic = gate.approved.length === 0;
manifest.notice = gate.realApproved
  ? '合成演示数据与经作者批准的真实样例并存；未批准内容不在发布产物中。'
  : '全部公开样例均为合成演示数据；真实样例等待作者逐段批准。';

const realSessions: typeof manifest.sessions = [];
if (gate.approved.length) {
  await mkdir(join(DIST, 'samples', 'real'), { recursive: true });
  for (const sample of gate.approved) {
    await writeFile(join(DIST, 'samples', 'real', sample.file), sample.text);
    const parsed = JSON.parse(sample.text) as { session?: { id?: string; title?: string; summary?: string; stats?: unknown } };
    realSessions.push({
      file: `real/${sample.file}`,
      id: parsed.session?.id ?? sample.id,
      title: parsed.session?.title ?? sample.id,
      summary: parsed.session?.summary ?? '经作者批准的真实样例',
      stats: parsed.session?.stats ?? {},
    });
  }
}
manifest.sessions = [...manifest.sessions, ...realSessions];
await writeFile(join(DIST, 'samples', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const blocked = gate.rejected.filter((entry) => entry.reason === 'sensitive-hit');
if (blocked.length) {
  console.log(`sample gate: rejected ${blocked.length} approved candidate(s) due to sensitive hits: ${blocked.map((entry) => entry.id).join(', ')}`);
}
console.log(JSON.stringify({
  dist: DIST,
  syntheticSessions: syntheticManifest.sessions.length,
  realSessionsApproved: gate.approved.length,
  realSamplesApproved: gate.realApproved,
  gateReason: gate.reason,
}, null, 2));