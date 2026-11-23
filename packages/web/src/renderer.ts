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
  ci: number;
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
  private userAdjusted = false;
  private needsDraw = true;
  private raf = 0;
  private frameTimes: number[] = [];
  private frames = 0;
  private lastStatsAt = 0;
  private dotPattern: CanvasPattern | null = null;
  private layoutGroups = new Map<number, SimNode[][]>();
  private groupReps = new Set<string>();
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
          ci: -1,
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
          .distance((l) => ((l.source as SimNode).ci === (l.target as SimNode).ci ? 94 : 200))
          .strength((l) => ((l.source as SimNode).ci === (l.target as SimNode).ci ? 0.45 : 0.18)),
      )
      .force('charge', forceManyBody<SimNode>().strength(-180).distanceMax(420))
      .force('clusterX', forceX<SimNode>((d) => d.cx).strength(0.3))
      .force('clusterY', forceY<SimNode>((d) => d.cy).strength(0.3))
      .force('collide', forceCollide<SimNode>((d) => d.r + 10).iterations(1));
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

  private turnOrder(nodes: SimNode[]): SimNode[] {
    return [...nodes].sort((a, b) => a.node.bornTurn - b.node.bornTurn || a.id.localeCompare(b.id));
  }

  private relatedGroups(nodes: SimNode[]): SimNode[][] {
    const ids = new Set(nodes.map((sn) => sn.id));
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      const p = parent.get(id) ?? id;
      if (p === id) return id;
      const root = find(p);
      parent.set(id, root);
      return root;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    // membership comes from semantic edges only: sharing a turn is context,
    // not relatedness, since one thread can drift into other topics
    for (const edge of this.map.edges) {
      if (ids.has(edge.from) && ids.has(edge.to)) union(edge.from, edge.to);
    }
    const buckets = new Map<string, SimNode[]>();
    for (const sn of this.turnOrder(nodes)) {
      const root = find(sn.id);
      const bucket = buckets.get(root);
      if (bucket) bucket.push(sn);
      else buckets.set(root, [sn]);
    }
    return [...buckets.values()].sort((a, b) => {
      const ca = this.activityCenter(a);
      const cb = this.activityCenter(b);
      return ca - cb || a[0].id.localeCompare(b[0].id);
    });
  }

  private activityCenter(group: SimNode[]): number {
    let sum = 0;
    for (const sn of group) sum += (sn.node.bornTurn + sn.node.lastTurn) / 2;
    return sum / group.length;
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
    const clusterIndex = new Map<string, number>();
    for (const shape of this.clusterShapes) {
      for (const sn of shape.nodes) clusterIndex.set(sn.id, shape.index);
    }
    for (const sn of this.simNodes) {
      sn.cx = 0;
      sn.cy = 0;
      sn.ci = clusterIndex.get(sn.id) ?? -1;
    }

    this.layoutGroups = new Map();
    this.groupReps = new Set();
    // one chronological chain: relational groups placed as stations on a
    // serpentine spine so the project's stage progression reads as a single path
    const groups = this.relatedGroups(this.simNodes);
    this.layoutGroups.set(0, groups);
    const ROW_WIDTH = 1000;
    const GROUP_GAP = 130;
    const ROW_GAP = 120;
    const innerOf = (n: number): number => (n === 1 ? 0 : 22 + Math.min(n, 10) * 9);
    const extents = groups.map((group) => innerOf(group.length) + 30);
    const rowOf: number[] = [];
    const offsetOf: number[] = [];
    const rowEnds: number[] = [];
    let cursor = 0;
    let row = 0;
    groups.forEach((_, gi) => {
      const e = extents[gi];
      const advance = cursor === 0 ? e : GROUP_GAP + e;
      if (cursor > 0 && cursor + advance + e > ROW_WIDTH) {
        rowEnds.push(cursor);
        row += 1;
        cursor = 0;
      }
      const center = cursor === 0 ? e : cursor + GROUP_GAP + e;
      rowOf[gi] = row;
      offsetOf[gi] = center;
      cursor = center + e;
    });
    rowEnds.push(cursor);
    const rowMax = new Array<number>(rowEnds.length).fill(0);
    groups.forEach((_, gi) => {
      rowMax[rowOf[gi]] = Math.max(rowMax[rowOf[gi]], extents[gi]);
    });
    const rowY: number[] = [];
    let y = 0;
    for (let r = 0; r < rowEnds.length; r++) {
      rowY[r] = y + rowMax[r];
      y += rowMax[r] * 2 + ROW_GAP;
    }
    const totalH = y - ROW_GAP;
    groups.forEach((group, gi) => {
      const r = rowOf[gi];
      const width = rowEnds[r];
      const leftToRight = r % 2 === 0;
      const gx = (leftToRight ? offsetOf[gi] : width - offsetOf[gi]) - width / 2;
      const gy = rowY[r] - totalH / 2;
      const inner = innerOf(group.length);
      group.forEach((sn, slot) => {
        const rr = inner * Math.sqrt((slot + 0.5) / group.length);
        const sa = slot * 2.399963229728653;
        sn.cx = gx + Math.cos(sa) * rr;
        sn.cy = gy + Math.sin(sa) * rr;
      });
      const rep = [...group].sort(
        (a, b) =>
          b.node.rings.length - a.node.rings.length ||
          a.node.bornTurn - b.node.bornTurn ||
          a.id.localeCompare(b.id),
      )[0];
      this.groupReps.add(rep.id);
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
    this.userAdjusted = true;
    if (this.k < 0.95) this.k = 1.0;
    this.tier = tierForZoom(this.k);
    this.tx = this.w / 2 - (sn.x ?? 0) * this.k;
    this.ty = this.h / 2 - (sn.y ?? 0) * this.k;
    this.needsDraw = true;
    return true;
  }

  setZoom(k: number): number {
    this.userAdjusted = true;
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
    const k0 = Math.min(this.w / (extentW + 160), this.h / (extentH + 160));
    // labels render in screen space, so fit must reserve their width or edge
    // labels clip against the canvas
    this.ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    const labelLimit = tierForZoom(Math.min(Math.max(k0, 0.18), 1.4)) === 'near' ? 14 : 8;
    let labelHalf = 0;
    for (const sn of this.simNodes) {
      const text = this.groupReps.has(sn.id) ? sn.node.label : truncate(sn.node.label, labelLimit);
      const half = this.ctx.measureText(text).width / 2;
      if (half > labelHalf) labelHalf = half;
    }
    const padX = Math.max(28, labelHalf + 10);
    const padY = 30;
    this.k = Math.min(
      Math.max(
        Math.min((this.w - 2 * padX) / extentW, (this.h - padY - 24) / extentH),
        0.18,
      ),
      1.4,
    );
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
    this.dotPattern = null;
    if (this.hasFit && !this.userAdjusted) this.fitView();
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
      // center from the first paint: re-fit each settling frame until first fit or user takeover
      if (!this.hasFit && !this.userAdjusted) this.fitView();
      if (this.sim.alpha() < 0.02 && !growing) {
        this.active = false;
        this.converged = true;
        if (!this.hasFit) {
          this.hasFit = true;
          if (!this.userAdjusted) this.fitView();
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
    ctx.fillStyle = '#f4f7fc';
    ctx.fillRect(0, 0, this.w, this.h);
    const dots = this.ensureDotPattern();
    if (dots) {
      ctx.fillStyle = dots;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    if (this.simNodes.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无星图数据 · 等待对话流入', this.w / 2, this.h / 2);
      this.emitStats(now);
      return;
    }

    this.tier = tierForZoom(this.k);
    const overview = this.tier !== 'near' && this.focus === null;

    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.k, this.k);

    {
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1.2 / this.k;
      ctx.globalAlpha = overview ? 0.38 : 0.22;
      ctx.setLineDash([5 / this.k, 4 / this.k]);
      const centroids: { x: number; y: number }[] = [];
      for (const groups of this.layoutGroups.values()) {
        if (groups.length < 2) continue;
        ctx.beginPath();
        groups.forEach((group, gi) => {
          let sx = 0;
          let sy = 0;
          for (const sn of group) {
            sx += sn.x ?? 0;
            sy += sn.y ?? 0;
          }
          const x = sx / group.length;
          const y = sy / group.length;
          centroids.push({ x, y });
          if (gi === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = overview ? 0.55 : 0.35;
      ctx.fillStyle = '#94a3b8';
      for (const c of centroids) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 2.4 / this.k, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = overview ? 0.3 : 0.2;
      const turnNodes = new Map<number, SimNode[]>();
      for (const sn of this.simNodes) {
        const list = turnNodes.get(sn.node.bornTurn);
        if (list) list.push(sn);
        else turnNodes.set(sn.node.bornTurn, [sn]);
      }
      ctx.beginPath();
      for (const list of turnNodes.values()) {
        if (list.length < 2) continue;
        list.sort((a, b) => a.id.localeCompare(b.id));
        if (list.length <= 8) {
          for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
              const a = list[i];
              const b = list[j];
              if (a.ci !== b.ci) continue;
              ctx.moveTo(a.x ?? 0, a.y ?? 0);
              ctx.lineTo(b.x ?? 0, b.y ?? 0);
            }
          }
        } else {
          const hub = list[0];
          for (let i = 1; i < list.length; i++) {
            const b = list[i];
            if (hub.ci !== b.ci) continue;
            ctx.moveTo(hub.x ?? 0, hub.y ?? 0);
            ctx.lineTo(b.x ?? 0, b.y ?? 0);
          }
        }
      }
      ctx.stroke();
    }

    const groups = new Map<string, { visual: ReturnType<typeof edgeVisual>; alpha: number; path: Path2D }>();
    for (const link of this.simLinks) {
      const source = link.source as SimNode;
      const target = link.target as SimNode;
      if (typeof source !== 'object' || typeof target !== 'object') continue;
      const outside = this.focus !== null && (!this.focus.has(source.id) || !this.focus.has(target.id));
      let alpha = outside ? 0.08 : link.edge.kind === 'related' ? 0.55 : 0.9;
      if (overview && !outside) alpha = link.edge.kind === 'related' ? 0.72 : 1;
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
      ctx.lineWidth = (group.visual.width + (overview ? 0.5 : 0)) / this.k;
      ctx.setLineDash(group.visual.dash.map((d) => d / this.k));
      ctx.stroke(group.path);
    }
    ctx.setLineDash([]);

    for (const sn of this.simNodes) {
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
        ctx.strokeStyle = '#1b2434';
        ctx.lineWidth = 1.5 / this.k;
        ctx.beginPath();
        ctx.arc(x, y, r + 5 / this.k, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (this.searchIds.has(sn.id)) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#d97706';
        ctx.lineWidth = 1.8 / this.k;
        ctx.beginPath();
        ctx.arc(x, y, r + 4.5 / this.k, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (visual.strike) {
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#64748b';
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
        ctx.strokeStyle = '#d97706';
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

    const placedRects: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const labelNodes = overview
      ? this.simNodes
          .filter((sn) => sn.grow >= 0.6 && this.overviewLabel(sn))
          .sort((a, b) => this.labelPriority(a) - this.labelPriority(b) || a.id.localeCompare(b.id))
      : this.simNodes;
    for (const sn of labelNodes) {
      if (sn.grow < 0.6) continue;
      if (!overview && !this.showLabel(sn)) continue;
      const visual = nodeVisual(sn.node);
      const outside = this.focus !== null && !this.focus.has(sn.id);
      const sx = (sn.x ?? 0) * this.k + this.tx;
      const sy = (sn.y ?? 0) * this.k + this.ty + sn.r * this.k + 13;
      const alpha = outside ? 0.1 : visual.dim ? 0.62 : 0.92;
      if (alpha !== currentAlpha) {
        ctx.globalAlpha = alpha;
        currentAlpha = alpha;
      }
      const fill = visual.strike ? '#6b7280' : sn.node.type === 'shift' ? '#92400e' : '#1f2937';
      if (fill !== currentFill) {
        ctx.fillStyle = fill;
        currentFill = fill;
      }
      const text =
        overview && this.groupReps.has(sn.id) ? sn.node.label : truncate(sn.node.label, overview ? 8 : 14);
      const width = ctx.measureText(text).width;
      if (overview) {
        const x1 = sx - width / 2 - 2;
        const y1 = sy - 11;
        const x2 = sx + width / 2 + 2;
        const y2 = sy + 3;
        if (placedRects.some((r) => x1 < r.x2 && x2 > r.x1 && y1 < r.y2 && y2 > r.y1)) continue;
        placedRects.push({ x1, y1, x2, y2 });
      }
      ctx.fillText(text, sx, sy);
      if (visual.strike) {
        ctx.strokeStyle = '#6b7280';
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

  private ensureDotPattern(): CanvasPattern | null {
    if (this.dotPattern) return this.dotPattern;
    const tilePx = Math.max(1, Math.round(24 * this.dpr));
    const tile = document.createElement('canvas');
    tile.width = tilePx;
    tile.height = tilePx;
    const tctx = tile.getContext('2d');
    if (!tctx) return null;
    tctx.fillStyle = '#e6ecf5';
    tctx.beginPath();
    tctx.arc(tilePx / 2, tilePx / 2, Math.max(1, Math.round(this.dpr)), 0, Math.PI * 2);
    tctx.fill();
    const pattern = this.ctx.createPattern(tile, 'repeat');
    if (!pattern) return null;
    pattern.setTransform(new DOMMatrix().scale(24 / tilePx));
    this.dotPattern = pattern;
    return pattern;
  }

  private overviewLabel(sn: SimNode): boolean {
    if (sn.id === this.selectedId || this.searchIds.has(sn.id)) return true;
    if (this.k < 0.3) return sn.node.type === 'shift';
    return sn.node.type !== 'ai-voice';
  }

  private labelPriority(sn: SimNode): number {
    if (sn.id === this.selectedId || this.searchIds.has(sn.id)) return 0;
    if (sn.node.type === 'shift') return 1;
    if (this.groupReps.has(sn.id)) return 2;
    return 3;
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
    for (let i = this.simNodes.length - 1; i >= 0; i--) {
      const sn = this.simNodes[i];
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
      this.userAdjusted = true;
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
    this.userAdjusted = true;
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