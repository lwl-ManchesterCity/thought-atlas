import { StarMapRenderer } from '../../packages/web/src/renderer.ts';
import { loadJson, mapAt, type SampleDoc, type SampleManifest } from './common.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#hero-map');
const figure = document.querySelector<HTMLElement>('.hero-map');
const wide = window.matchMedia('(min-width: 961px)');
let mounted = false;

async function mountHeroMap(): Promise<void> {
  if (mounted || !canvas || !wide.matches) return;
  mounted = true;
  try {
    const manifest = await loadJson<SampleManifest>('/samples/manifest.json');
    const sample = manifest.sessions.reduce((best, next) => (next.stats.nodes > best.stats.nodes ? next : best), manifest.sessions[0]);
    if (!sample) return;
    const doc = await loadJson<SampleDoc>(`/samples/${sample.file}`);
    new StarMapRenderer(canvas).setMap(mapAt(doc, doc.session.turns.length));
    if (figure) figure.hidden = false;
  } catch {
    // 首页星图只是视觉锚点，样例加载失败时整块隐藏，不影响正文与入口
  }
}

wide.addEventListener('change', () => void mountHeroMap());
void mountHeroMap();
