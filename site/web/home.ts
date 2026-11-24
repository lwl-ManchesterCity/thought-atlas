import { StarMapRenderer } from '../../packages/web/src/renderer.ts';
import { loadJson, mapAt, type SampleDoc, type SampleManifest } from './common.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#hero-map');
const figure = document.querySelector<HTMLElement>('.hero-map');
const wide = window.matchMedia('(min-width: 961px)');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const STEP_MS = 900;
const HOLD_MS = 3200;
let mounted = false;

async function mountHeroMap(): Promise<void> {
  if (mounted || !canvas || !wide.matches) return;
  mounted = true;
  try {
    const manifest = await loadJson<SampleManifest>('/samples/manifest.json');
    const sample = manifest.sessions.reduce((best, next) => (next.stats.nodes > best.stats.nodes ? next : best), manifest.sessions[0]);
    if (!sample) return;
    const doc = await loadJson<SampleDoc>(`/samples/${sample.file}`);
    const total = doc.session.turns.length;
    const renderer = new StarMapRenderer(canvas, { stepOrder: true, rowWidth: 520 });
    let turn = reduced.matches ? total : 1;
    let holdUntil = 0;
    renderer.setMap(mapAt(doc, turn));
    if (!reduced.matches) {
      window.setInterval(() => {
        const now = Date.now();
        if (now < holdUntil) return;
        turn = turn >= total ? 1 : turn + 1;
        if (turn === total) holdUntil = now + HOLD_MS;
        renderer.setMap(mapAt(doc, turn), { animate: true });
      }, STEP_MS);
    }
    window.__atlasSite = {
      ready: true,
      nodes: () => renderer.getStats().nodes,
      turn: () => turn,
      setTurn: (t: number) => {
        // probe hook: freeze the auto loop at a chosen turn
        holdUntil = Number.MAX_SAFE_INTEGER;
        turn = Math.min(Math.max(t, 1), total);
        renderer.setMap(mapAt(doc, turn));
        renderer.fitView();
      },
      settled: () => renderer.getStats().converged,
      fit: () => renderer.fitView(),
    };
    if (figure) figure.hidden = false;
  } catch {
    // 首页星图只是视觉锚点，样例加载失败时整块隐藏，不影响正文与入口
  }
}

wide.addEventListener('change', () => void mountHeroMap());
void mountHeroMap();