import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphMap, ThoughtNode, ThoughtEdge } from '@thought-atlas/core';
import {
  computeNeighborhood,
  convexHull,
  diffMap,
  edgeVisual,
  mapSignature,
  nodeRadius,
  nodeVisual,
  tierForZoom,
  type ZoomTier,
} from './graph-model.ts';
import { computeClusters } from '@thought-atlas/core';

interface SimNode extends SimulationNodeDatum {
  id: string;
  node: ThoughtNode;
  r: number;
  grow: number;
  bornAt: number;
  cx: number;
  cy: number;
}

type SimLink = SimulationLinkDatum<SimNode> & { edge: ThoughtEdge };

export interface RendererStats {
  fps: number;
  frames: number;
  nodes: number;
  edges: number;
  converged: boolean;
  zoom: number;
  focused: boolean;
  selected: string | null;
  lastDrawAt: number;
  tier: ZoomTier;
  clusters: number;
  namedClusters: number;
  pulsing: number;
  searchMatches: number;
}

export interface RendererOptions {
  onSelect?: (node: ThoughtNode | null) => void;
  onStats?: (stats: RendererStats) => void;
}

const GROW_MS = 450;
const PULSE_MS = 1300;
const CLUSTER_COLORS = ['#4c8dff', '#f0a24a', '#5fd09a', '#c78bff', '#ff7b8a', '#59c7e8', '#d7c56a', '#8fa0ff'];

interface ClusterShape {
  key: string;
  index: number;
  nodes: SimNode[];
}

function easeOut(t: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  return 1 - Math.pow(1 - x, 3);
}

function truncate(text: string, max = 14): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class StarMapRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private options: RendererOptions;
  private map: GraphMap = { sessionId: '', nodes: [], edges: [], lastTurn: 0 };
  private signature = '';
  private sim: Simulation<SimNode, SimLink> | null = null;
  private simNodes: SimNode[] = [];
  private simLinks: SimLink[] = [];
  private byId = new Map<string, SimNode>();
  private focus: Set<string> | null = null;
  private selectedId: string | null = null;
  private searchIds = new Set<string>();
  private pulses = new Map<string, number>();
  private clusterLabels = new Map<string, string>();
  private clusterShapes: ClusterShape[] = [];
  private tier: ZoomTier = 'near';
  private k = 1;
  private tx = 0;
  private ty = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private active = false;
  private animating = false;
  private converged = true;
  private hasFit = false;
  private needsDraw = true;
  private raf = 0;
  private frameTimes: number[] = [];
  private frames = 0;
  private lastStatsAt = 0;
  private dragging: SimNode | null = null;
  private panning = false;
  private pointerMoved = false;
  private pointerStart = { x: 0, y: 0 };
  private panStart = { tx: 0, ty: 0 };
  private resizeObserver: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.options = options;
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.raf = requestAnimationFrame(this.frame);
  }

  setMap(map: GraphMap, options: { animate?: boolean } = {}): void {
    const prev = this.map;
    const diff = diffMap(prev, map);
    const sig = mapSignature(map);
    this.map = map;
    if (sig === this.signature) {
      this.needsDraw = true;
      return;
    }
    this.signature = sig;

    const nextIds = new Set(map.nodes.map((n) => n.id));
    for (const gone of diff.removed) {
      this.byId.delete(gone);
    }
    this.simNodes = this.simNodes.filter((sn) => nextIds.has(sn.id));

    for (const node of map.nodes) {
      const existing = this.byId.get(node.id);
      if (existing) {
        existing.node = node;
        existing.r = nodeRadius(node);
      } else {
        const anchor = this.findAnchor(node.id, map);
        const sn: SimNode = {
          id: node.id,
          node,
          r: nodeRadius(node),
          grow: options.animate ? 0 : 1,
          bornAt: performance.now(),
          cx: 0,
          cy: 0,
          x: anchor ? anchor.x! + (Math.random() - 0.5) * 40 : (Math.random() - 0.5) * 120,
          y: anchor ? anchor.y! + (Math.random() - 0.5) * 40 : (Math.random() - 0.5) * 120,
        };
        this.byId.set(node.id, sn);
        this.simNodes.push(sn);
      }
    }

    this.simLinks = map.edges.map((edge) => ({ source: edge.from, target: edge.to, edge }));
    const hadNodes = prev.nodes.length > 0;
    this.recomputeClusters();
    this.buildSimulation(hadNodes ? 0.3 : 1);

    if (this.selectedId && !this.byId.has(this.selectedId)) {
      this.selectedId = null;
      this.focus = null;
      this.options.onSelect?.(null);
    } else if (this.focus && this.selectedId && this.byId.has(this.selectedId)) {
      this.focus = computeNeighborhood(map, this.selectedId);
    }
    this.needsDraw = true;
  }

  private findAnchor(id: string, map: GraphMap): SimNode | undefined {
    for (const edge of map.edges) {
      const other = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
      if (other) {
        const sn = this.byId.get(other);
        if (sn && sn.x !== undefined && sn.y !== undefined) return sn;
      }
    }
    return undefined;
  }

  private buildSimulation(alpha: number): void {
    if (this.simNodes.length === 0) {
      this.sim = null;
      this.active = false;
      this.converged = true;
      return;
    }
    const sim = forceSimulation<SimNode, SimLink>(this.simNodes)
      .stop()
      .alphaDecay(0.028)
      .velocityDecay(0.36)
      .force(
        'link',
        forceLink<SimNode, SimLink>(this.simLinks)
          .id((d) => d.id)
          .distance(52)
          .strength(0.45),
      )
      .force('charge', forceManyBody<SimNode>().strength(-180).distanceMax(420))
      .force('clusterX', forceX<SimNode>((d) => d.cx).strength(0.08))
      .force('clusterY', forceY<SimNode>((d) => d.cy).strength(0.08))
      .force('collide', forceCollide<SimNode>((d) => d.r + 4).iterations(1));
    sim.alpha(alpha);
    this.sim = sim;
    this.active = true;
    this.converged = false;
    this.animating = this.simNodes.some((sn) => sn.grow < 1);
  }

  reheat(alpha = 0.6): void {
    if (!this.sim) return;
    this.sim.alpha(Math.max(this.sim.alpha(), alpha));
    this.active = true;
    this.converged = false;
    this.needsDraw = true;
  }

  focusNode(id: string): void {
    if (!this.byId.has(id)) return;
    this.selectedId = id;
    this.focus = computeNeighborhood(this.map, id);
    this.needsDraw = true;
    const node = this.byId.get(id)?.node ?? null;
    this.options.onSelect?.(node);
  }

  clearFocus(): void {
    this.selectedId = null;
    this.focus = null;
    this.needsDraw = true;
    this.options.onSelect?.(null);
  }

  private recomputeClusters(): void {
    const snapshot = computeClusters(this.map);
    this.clusterShapes = snapshot.clusters
      .map((group) => ({
        key: group.key,
        index: group.index,
        nodes: group.nodeIds
          .map((id) => this.byId.get(id))
          .filter((sn): sn is SimNode => sn !== undefined),
      }))
      .filter((shape) => shape.nodes.length >= 2);
    for (const sn of this.simNodes) {
      sn.cx = 0;
      sn.cy = 0;
    }
    const count = this.clusterShapes.length;
    const radius = count > 1 ? 140 + Math.min(count, 16) * 26 : 0;
    this.clusterShapes.forEach((shape, index) => {
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
      const cx = Math.cos(angle) * radius;
      const cy = Math.sin(angle) * radius;
      for (const sn of shape.nodes) {
        sn.cx = cx;
        sn.cy = cy;
      }
    });
  }

  setClusterLabels(labels: Map<string, string>): void {
    this.clusterLabels = new Map(labels);
    this.needsDraw = true;
  }

  setSearchMatches(ids: Iterable<string>): void {
    this.searchIds = new Set(ids);
    this.needsDraw = true;
  }

  pulseShift(id: string): void {
    if (!this.byId.has(id)) return;
    this.pulses.set(id, performance.now());
    this.needsDraw = true;
  }

  centerOn(id: string): boolean {
    const sn = this.byId.get(id);
    if (!sn) return false;
    if (this.k < 0.95) this.k = 1.0;
    this.tier = tierForZoom(this.k);
    this.tx = this.w / 2 - (sn.x ?? 0) * this.k;
    this.ty = this.h / 2 - (sn.y ?? 0) * this.k;
    this.needsDraw = true;
    return true;
  }

  setZoom(k: number): number {
    const next = Math.min(Math.max(k, 0.25), 3);
    const cx = (this.w / 2 - this.tx) / this.k;
    const cy = (this.h / 2 - this.ty) / this.k;
    this.k = next;
    this.tier = tierForZoom(next);
    this.tx = this.w / 2 - cx * next;
    this.ty = this.h / 2 - cy * next;
    this.needsDraw = true;
    return next;
  }

  private activePulses(now: number): number {
    let count = 0;
    let expired = false;
    for (const [id, started] of this.pulses) {
      if (now - started > PULSE_MS) {
        this.pulses.delete(id);
        expired = true;
      } else {
        count++;
      }
    }
    if (expired) this.needsDraw = true;
    return count;
  }

  fitView(): void {
    if (this.simNodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const sn of this.simNodes) {
      minX = Math.min(minX, sn.x ?? 0);
      minY = Math.min(minY, sn.y ?? 0);
      maxX = Math.max(maxX, sn.x ?? 0);
      maxY = Math.max(maxY, sn.y ?? 0);
    }
    const extentW = Math.max(maxX - minX, 80);
    const extentH = Math.max(maxY - minY, 80);
    this.k = Math.min(Math.max(Math.min(this.w / (extentW + 160), this.h / (extentH + 160)), 0.35), 1.4);
    this.tier = tierForZoom(this.k);
    this.tx = this.w / 2 - ((minX + maxX) / 2) * this.k;
    this.ty = this.h / 2 - ((minY + maxY) / 2) * this.k;
    this.needsDraw = true;
  }

  screenOf(id: string): { x: number; y: number } | null {
    const sn = this.byId.get(id);
    if (!sn) return null;
    return { x: (sn.x ?? 0) * this.k + this.tx, y: (sn.y ?? 0) * this.k + this.ty };
  }

  getStats(): RendererStats {
    return {
      fps: this.currentFps(),
      frames: this.frames,
      nodes: this.simNodes.length,
      edges: this.map.edges.length,
      converged: this.converged,
      zoom: Number(this.k.toFixed(2)),
      focused: this.focus !== null,
      selected: this.selectedId,
      lastDrawAt: this.frameTimes.length ? Math.round(performance.now() - this.frameTimes[this.frameTimes.length - 1]) : -1,
      tier: this.tier,
      clusters: this.clusterShapes.length,
      namedClusters: this.clusterShapes.filter((shape) => this.clusterLabels.has(shape.key)).length,
      pulsing: this.pulses.size,
      searchMatches: this.searchIds.size,
    };
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.sim?.stop();
  }

  private currentFps(): number {
    const cutoff = performance.now() - 1000;
    while (this.frameTimes.length && this.frameTimes[0] < cutoff) this.frameTimes.shift();
    return this.frameTimes.length;
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.floor(rect.width));
    this.h = Math.max(1, Math.floor(rect.height));
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.needsDraw = true;
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    if (this.active && this.sim) {
      this.sim.tick();
      let growing = false;
      for (const sn of this.simNodes) {
        if (sn.grow < 1) {
          sn.grow = easeOut((now - sn.bornAt) / GROW_MS);
          growing = true;
        }
      }
      this.animating = growing;
      if (this.sim.alpha() < 0.02 && !growing) {
        this.active = false;
        this.converged = true;
        if (!this.hasFit) {
          this.hasFit = true;
          this.fitView();
        }
      }
      this.draw(now);
      return;
    }
    if (this.animating) {
      let growing = false;
      for (const sn of this.simNodes) {
        if (sn.grow < 1) {
          sn.grow = easeOut((now - sn.bornAt) / GROW_MS);
          growing = true;
        }
      }
      this.animating = growing;
      this.draw(now);
      return;
    }
    if (this.activePulses(now) > 0 || this.needsDraw) this.draw(now);
  };

  private draw(now: number): void {
    this.needsDraw = false;
    this.frames++;
    this.frameTimes.push(now);
    if (this.frameTimes.length > 240) this.frameTimes.shift();

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#0a0e18';
    ctx.fillRect(0, 0, this.w, this.h);

    if (this.simNodes.length === 0) {
      ctx.fillStyle = '#5d6a86';
      ctx.font = '14px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无星图数据 · 等待对话流入', this.w / 2, this.h / 2);
      this.emitStats(now);
      return;
    }

    this.tier = tierForZoom(this.k);
    const far = this.tier === 'far' && this.focus === null;

    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.k, this.k);

    if (far) {
      for (const shape of this.clusterShapes) {
        const color = CLUSTER_COLORS[shape.index % CLUSTER_COLORS.length];
        const pts: { x: number; y: number }[] = [];
        for (const sn of shape.nodes) {
          const x = sn.x ?? 0;
          const y = sn.y ?? 0;
          const r = sn.r + 12;
          pts.push({ x: x - r, y: y - r }, { x: x + r, y: y - r }, { x: x + r, y: y + r }, { x: x - r, y: y + r });
        }
        const hull = convexHull(pts);
        if (hull.length < 3) continue;
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(hull[0].x, hull[0].y);
        for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4 / this.k;
        ctx.setLineDash([6 / this.k, 5 / this.k]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    const groups = new Map<string, { visual: ReturnType<typeof edgeVisual>; alpha: number; path: Path2D }>();
    for (const link of this.simLinks) {
      const source = link.source as SimNode;
      const target = link.target as SimNode;
      if (typeof source !== 'object' || typeof target !== 'object') continue;
      if (far) continue;
      const outside = this.focus !== null && (!this.focus.has(source.id) || !this.focus.has(target.id));
      const alpha = outside ? 0.08 : link.edge.kind === 'related' ? 0.55 : 0.9;
      const key = `${link.edge.kind}:${alpha}`;
      let group = groups.get(key);
      if (!group) {
        group = { visual: edgeVisual(link.edge.kind), alpha, path: new Path2D() };
        groups.set(key, group);
      }
      group.path.moveTo(source.x ?? 0, source.y ?? 0);
      group.path.lineTo(target.x ?? 0, target.y ?? 0);
    }
    for (const group of groups.values()) {
      ctx.globalAlpha = group.alpha;
      ctx.strokeStyle = group.visual.stroke;
      ctx.lineWidth = group.visual.width / this.k;
      ctx.setLineDash(group.visual.dash.map((d) => d / this.k));
      ctx.stroke(group.path);
    }
    ctx.setLineDash([]);

    for (const sn of this.simNodes) {
      if (far && sn.node.type !== 'shift' && sn.id !== this.selectedId) continue;
      const visual = nodeVisual(sn.node);
      const outside = this.focus !== null && !this.focus.has(sn.id);
      const alpha = outside ? 0.1 : visual.dim ? 0.75 : 1;
      const r = sn.r * (0.35 + 0.65 * sn.grow);
      const x = sn.x ?? 0;
      const y = sn.y ?? 0;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = visual.fill;
      ctx.strokeStyle = visual.stroke;
      ctx.lineWidth = visual.strokeWidth / this.k;
      ctx.beginPath();
      if (visual.shape === 'diamond') {
        ctx.moveTo(x, y - r * 1.15);
        ctx.lineTo(x + r * 1.15, y);
        ctx.lineTo(x, y + r * 1.15);
        ctx.lineTo(x - r * 1.15, y);
        ctx.closePath();
      } else {
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
      if (sn.id === this.selectedId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5 / this.k;
        ctx.beginPath();
        ctx.arc(x, y, r + 5 / this.k, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (this.searchIds.has(sn.id)) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffd66b';
        ctx.lineWidth = 1.8 / this.k;
        ctx.beginPath();
        ctx.arc(x, y, r + 4.5 / this.k, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (visual.strike) {
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#aab2c5';
        ctx.lineWidth = 1.2 / this.k;
        ctx.beginPath();
        ctx.moveTo(x - r * 0.8, y + r * 0.8);
        ctx.lineTo(x + r * 0.8, y - r * 0.8);
        ctx.stroke();
      }
      const pulseStart = this.pulses.get(sn.id);
      if (pulseStart !== undefined && now - pulseStart <= PULSE_MS) {
        const t = Math.max(0, (now - pulseStart) / PULSE_MS);
        ctx.globalAlpha = (1 - t) * 0.9;
        ctx.strokeStyle = '#ffd08a';
        ctx.lineWidth = 2.2 / this.k;
        ctx.beginPath();
        ctx.arc(x, y, r + (6 + t * 30) / this.k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();

    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    let currentFill = '';
    let currentAlpha = -1;

    if (far) {
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
      for (const shape of this.clusterShapes) {
        let sx = 0;
        let sy = 0;
        for (const sn of shape.nodes) {
          sx += sn.x ?? 0;
          sy += sn.y ?? 0;
        }
        const cx = (sx / shape.nodes.length) * this.k + this.tx;
        const cy = (sy / shape.nodes.length) * this.k + this.ty;
        const label = truncate(this.clusterLabels.get(shape.key) ?? `簇 #${shape.index}`, 16);
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = 'rgba(10, 14, 24, 0.85)';
        ctx.lineWidth = 3;
        ctx.strokeText(label, cx, cy);
        ctx.fillStyle = CLUSTER_COLORS[shape.index % CLUSTER_COLORS.length];
        ctx.fillText(label, cx, cy);
      }
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    }

    for (const sn of this.simNodes) {
      if (sn.grow < 0.6) continue;
      if (far) {
        if (sn.id !== this.selectedId) continue;
      } else if (!this.showLabel(sn)) {
        continue;
      }
      const visual = nodeVisual(sn.node);
      const outside = this.focus !== null && !this.focus.has(sn.id);
      const sx = (sn.x ?? 0) * this.k + this.tx;
      const sy = (sn.y ?? 0) * this.k + this.ty + sn.r * this.k + 13;
      const alpha = outside ? 0.1 : visual.dim ? 0.62 : 0.92;
      if (alpha !== currentAlpha) {
        ctx.globalAlpha = alpha;
        currentAlpha = alpha;
      }
      const fill = visual.strike ? '#98a0b3' : sn.node.type === 'shift' ? '#ffd08a' : '#dbe4f5';
      if (fill !== currentFill) {
        ctx.fillStyle = fill;
        currentFill = fill;
      }
      const text = truncate(sn.node.label);
      ctx.fillText(text, sx, sy);
      if (visual.strike) {
        const width = ctx.measureText(text).width;
        ctx.strokeStyle = '#98a0b3';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx - width / 2, sy - 4);
        ctx.lineTo(sx + width / 2, sy - 4);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    this.emitStats(now);
  }

  private showLabel(sn: SimNode): boolean {
    if (sn.id === this.selectedId) return true;
    if (this.focus) return this.focus.has(sn.id);
    if (this.searchIds.has(sn.id)) return true;
    if (this.tier !== 'near') return false;
    return this.labelVisible(sn);
  }

  private labelVisible(sn: SimNode): boolean {
    if (this.focus?.has(sn.id)) return true;
    if (this.focus) return false;
    if (sn.id === this.selectedId) return true;
    if (sn.node.type === 'ai-voice') return this.k > 1.35;
    return true;
  }

  private emitStats(now: number): void {
    if (!this.options.onStats || now - this.lastStatsAt < 250) return;
    this.lastStatsAt = now;
    this.options.onStats(this.getStats());
  }

  private toWorld(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - this.tx) / this.k,
      y: (event.clientY - rect.top - this.ty) / this.k,
    };
  }

  private hitTest(point: { x: number; y: number }): SimNode | null {
    const farOnlyShift = this.focus === null && tierForZoom(this.k) === 'far';
    for (let i = this.simNodes.length - 1; i >= 0; i--) {
      const sn = this.simNodes[i];
      if (farOnlyShift && sn.node.type !== 'shift' && sn.id !== this.selectedId) continue;
      const dx = (sn.x ?? 0) - point.x;
      const dy = (sn.y ?? 0) - point.y;
      const r = sn.r + 5 / this.k;
      if (dx * dx + dy * dy <= r * r) return sn;
    }
    return null;
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.canvas.setPointerCapture(event.pointerId);
    this.pointerMoved = false;
    this.pointerStart = { x: event.clientX, y: event.clientY };
    const world = this.toWorld(event);
    const hit = this.hitTest(world);
    if (hit) {
      this.dragging = hit;
      hit.fx = world.x;
      hit.fy = world.y;
      this.reheat(0.35);
    } else {
      this.panning = true;
      this.panStart = { tx: this.tx, ty: this.ty };
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging && !this.panning) return;
    const dx = event.clientX - this.pointerStart.x;
    const dy = event.clientY - this.pointerStart.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this.pointerMoved = true;
    if (this.dragging) {
      const world = this.toWorld(event);
      this.dragging.fx = world.x;
      this.dragging.fy = world.y;
      this.reheat(0.3);
    } else if (this.panning) {
      this.tx = this.panStart.tx + dx;
      this.ty = this.panStart.ty + dy;
      this.needsDraw = true;
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    const wasDragging = this.dragging;
    const wasPanning = this.panning;
    const moved = this.pointerMoved;
    this.dragging = null;
    this.panning = false;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (wasDragging) {
      wasDragging.fx = null;
      wasDragging.fy = null;
      if (!moved) this.focusNode(wasDragging.id);
      return;
    }
    if (wasPanning && !moved) this.clearFocus();
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0012);
    const next = Math.min(Math.max(this.k * factor, 0.25), 3);
    this.tx = px - ((px - this.tx) / this.k) * next;
    this.ty = py - ((py - this.ty) / this.k) * next;
    this.k = next;
    this.tier = tierForZoom(next);
    this.needsDraw = true;
  };
}