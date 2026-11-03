// The 2D plan editor: draws the plan over its underlay in SVG and handles the drawing tools.
// SVG user units are plan metres with y negated (SVG y points down, plan y points up).
import type { Store } from '../app/store';
import { formatNumber, t } from '../i18n';
import { type Level, type OpeningKind, type RoomType, type Vec2, type WallKind } from '../model/plan';
import { add, dist, dot, norm, pointInPolygon, scale, sub } from '../model/geometry';
import { arcFromSagitta, arcPoint, arcSegments, sagittaThrough } from '../model/arc';
import {
  type Room, type WallFootprint, type WallPieces, detectRooms, fromWallLocal, indexLevel, levelBounds, wallFootprints, wallPieces,
  type LevelIndex, wallDistance, wallFrame, wallParam, wallPolyline, toWallLocal,
} from '../model/topology';
import {
  addCircle, addOpening, addRect, addRoomTag, addWall, deleteNode, deleteOpening, deleteRoomTag, deleteWall, moveNode, moveOpening, moveRoomTag, nodeById, settleNode,
  OPENING_WIDTHS, wallById, wallEnds,
} from '../model/edit';
import { type SnapResult, snapPoint } from './snap';
import { type UnderlayImage, type UnderlayTransform, defaultTransform } from './underlay';
import { Ask, parseLength } from './ask';
import { roomName } from '../ui/labels';

export type Tool = 'select' | 'wall' | 'arc' | 'rect' | 'circle' | 'door' | 'window' | 'slider' | 'passage' | 'room' | 'calibrate' | 'moveUnderlay';

export const OPENING_TOOLS: Partial<Record<Tool, OpeningKind>> = { door: 'door', window: 'window', slider: 'slider', passage: 'passage' };

export interface ToolOptions {
  wallKind: WallKind;
  thickness: number;
  roomType: RoomType;
}

type Hit =
  | { kind: 'node'; id: string }
  | { kind: 'opening'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'loop'; at: Vec2 };

type Drag =
  | { kind: 'pan'; last: [number, number] }
  | { kind: 'node'; id: string; moved: boolean; start: [number, number] }
  | { kind: 'wall'; id: string; moved: boolean; start: [number, number]; from: Vec2; ends: { id: string; p: Vec2 }[]; normal: Vec2 }
  | { kind: 'opening'; id: string; moved: boolean; start: [number, number] }
  | { kind: 'tag'; id: string; moved: boolean; start: [number, number] }
  | { kind: 'rect'; from: Vec2; moved: boolean; start: [number, number] }
  | { kind: 'circle'; from: Vec2; moved: boolean; start: [number, number] }
  | { kind: 'curve'; id: string; moved: boolean; start: [number, number] }
  | { kind: 'underlay'; last: Vec2; moved: boolean };

const SVGNS = 'http://www.w3.org/2000/svg';
const HIT_PX = 8;
const DRAG_PX = 3;

const ROOM_FILL: Record<RoomType, string> = {
  living: '#efe4d2', dining: '#efe4d2', kitchen: '#f0e8d6', bedroom: '#e2e7ee', office: '#e8e3ef',
  bathroom: '#d9e9ea', wc: '#d9e9ea', laundry: '#dde8e4', storage: '#e6e3dd', closet: '#e6e3dd',
  hallway: '#ecebe6', entry: '#ecebe6', safe_room: '#e9e0d3', balcony: '#e0e9d6', other: '#efece6',
};

interface Derived {
  rev: number;
  idx: LevelIndex;
  footprints: Map<string, WallFootprint>;
  pieces: Map<string, WallPieces>;
  rooms: Room[];
}

export class Editor2D {
  readonly svg: SVGSVGElement;
  private readonly layers: Record<'under' | 'rooms' | 'walls' | 'openings' | 'labels' | 'nodes' | 'select' | 'over', SVGGElement>;
  private readonly underImg: SVGImageElement;
  private readonly ask: Ask;
  private view = { cx: 0, cy: 0, s: 40 };
  private size = { w: 1, h: 1 };
  private derived?: Derived;
  private hover: Hit | null = null;
  private drag: Drag | null = null;
  private cursor: SnapResult | null = null;
  private rawCursor: Vec2 | null = null;
  private chain: Vec2 | null = null;
  private chainFirst: Vec2 | null = null;
  private rectFrom: Vec2 | null = null;
  /** Arc tool: the two ends, picked before the bow. */
  private arcEnds: Vec2[] = [];
  private calib: Vec2[] = [];
  private altKey = false;
  private spaceKey = false;
  private pointerInside = false;

  tool: Tool = 'select';
  opts: ToolOptions = { wallKind: 'interior', thickness: 0.12, roomType: 'bedroom' };
  underlay: UnderlayImage | null = null;
  underlayOpacity = 0.55;
  underlayVisible = true;
  onToolChange?: (tool: Tool) => void;
  onStatus?: (text: string) => void;
  onCalibrated?: () => void;

  constructor(private readonly host: HTMLElement, private readonly store: Store) {
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.classList.add('plan2d');
    this.svg.setAttribute('tabindex', '0');
    const mk = (name: string) => {
      const g = document.createElementNS(SVGNS, 'g');
      g.classList.add(`l-${name}`);
      this.svg.append(g);
      return g;
    };
    this.layers = {
      under: mk('under'), rooms: mk('rooms'), walls: mk('walls'), openings: mk('openings'),
      labels: mk('labels'), nodes: mk('nodes'), select: mk('select'), over: mk('over'),
    };
    this.underImg = document.createElementNS(SVGNS, 'image');
    this.underImg.setAttribute('preserveAspectRatio', 'none');
    this.layers.under.append(this.underImg);
    host.append(this.svg);
    this.ask = new Ask(host);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.bindPointer();
    store.on((e) => {
      if (e === 'load') { this.cancelTool(); this.fit(); }
      this.render();
    });
  }

  // ---------------------------------------------------------------- view

  private resize(): void {
    this.size = { w: Math.max(1, this.host.clientWidth), h: Math.max(1, this.host.clientHeight) };
    this.applyView();
  }

  private applyView(): void {
    const { w, h } = this.size, { cx, cy, s } = this.view;
    this.svg.setAttribute('viewBox', `${cx - w / 2 / s} ${-cy - h / 2 / s} ${w / s} ${h / s}`);
    this.svg.setAttribute('width', String(w));
    this.svg.setAttribute('height', String(h));
    this.render();
  }

  /** Plan point under a screen point (pixels relative to the editor). */
  toPlan(x: number, y: number): Vec2 {
    const { w, h } = this.size, { cx, cy, s } = this.view;
    return [cx + (x - w / 2) / s, cy - (y - h / 2) / s];
  }

  toScreen(p: Vec2): { x: number; y: number } {
    const { w, h } = this.size, { cx, cy, s } = this.view;
    return { x: w / 2 + (p[0] - cx) * s, y: h / 2 - (p[1] - cy) * s };
  }

  /** Frame the plan and the underlay. */
  fit(): void {
    const level = this.store.level;
    let min: Vec2 = [Infinity, Infinity], max: Vec2 = [-Infinity, -Infinity];
    const grow = (p: Vec2) => { min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])]; max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])]; };
    if (level.nodes.length) { const b = levelBounds(level); grow(b.min); grow(b.max); }
    const u = this.underlayRect();
    if (u && this.underlayVisible) { grow(u.min); grow(u.max); }
    if (!Number.isFinite(min[0])) { min = [-5, -5]; max = [5, 5]; }
    const pad = 1.2;
    const sw = (max[0] - min[0]) * pad, sh = (max[1] - min[1]) * pad;
    this.view = {
      cx: (min[0] + max[0]) / 2,
      cy: (min[1] + max[1]) / 2,
      s: Math.max(4, Math.min(400, Math.min(this.size.w / Math.max(sw, 1), this.size.h / Math.max(sh, 1)))),
    };
    this.applyView();
  }

  private zoomAt(x: number, y: number, factor: number): void {
    const p = this.toPlan(x, y);
    const s = Math.max(4, Math.min(800, this.view.s * factor));
    const { w, h } = this.size;
    this.view = { s, cx: p[0] - (x - w / 2) / s, cy: p[1] + (y - h / 2) / s };
    this.applyView();
  }

  private get tol(): number {
    return HIT_PX / this.view.s;
  }

  // ---------------------------------------------------------------- tools

  setTool(tool: Tool): void {
    if ((tool === 'calibrate' || tool === 'moveUnderlay') && !this.underlay) return;
    this.cancelTool();
    this.tool = tool;
    this.svg.dataset.tool = tool;
    this.onToolChange?.(tool);
    this.status();
    this.render();
  }

  /** Stop whatever is half-done (a wall chain, a rectangle, calibration). */
  cancelTool(): void {
    this.chain = this.chainFirst = this.rectFrom = null;
    this.arcEnds = [];
    this.calib = [];
    if (this.drag && this.drag.kind !== 'pan') this.store.cancel();
    this.drag = null;
    this.ask.close(null);
  }

  private status(): void {
    const key = {
      select: 'hint.select', wall: this.chain ? 'hint.wallNext' : 'hint.wall', rect: 'hint.rect',
      arc: ['hint.arc', 'hint.arc2', 'hint.arc3'][this.arcEnds.length], circle: 'hint.circle',
      door: 'hint.opening', window: 'hint.opening', slider: 'hint.opening', passage: 'hint.opening',
      room: 'hint.room', calibrate: this.calib.length ? 'hint.calibrate2' : 'hint.calibrate', moveUnderlay: 'hint.moveUnderlay',
    }[this.tool];
    this.onStatus?.(t(key));
  }

  /** Keyboard handling; returns true when the key was used. */
  handleKey(e: KeyboardEvent): boolean {
    if (this.ask.open) return false;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k.toLowerCase() === 'z') { e.shiftKey ? this.store.redo() : this.store.undo(); return true; }
    if (mod && k.toLowerCase() === 'y') { this.store.redo(); return true; }
    if (mod) return false;
    if (k === 'Escape') {
      if (this.chain || this.rectFrom || this.arcEnds.length || this.calib.length || this.drag) this.cancelTool();
      else if (this.tool !== 'select') this.setTool('select');
      else this.store.select(null);
      this.render();
      this.status();
      return true;
    }
    if (k === 'Enter' && this.chain) { this.endChain(); return true; }
    if ((k === 'Delete' || k === 'Backspace') && this.store.selection) { this.deleteSelection(); return true; }
    if (this.tool === 'wall' && this.chain && /^[0-9.,]$/.test(k)) { this.typeLength(k); return true; }
    const tools: Record<string, Tool> = { v: 'select', w: 'wall', a: 'arc', r: 'rect', c: 'circle', d: 'door', n: 'window', s: 'slider', o: 'passage', t: 'room' };
    const tool = tools[k.toLowerCase()];
    if (tool && !e.altKey) { this.setTool(tool); return true; }
    if (k.toLowerCase() === 'f') { this.fit(); return true; }
    return false;
  }

  get pointerOver(): boolean {
    return this.pointerInside;
  }

  deleteSelection(): void {
    const s = this.store.selection;
    if (!s || s.kind === 'loop') return;
    this.store.edit((l) => deleteSelected(l, s.kind, s.id));
    this.store.select(null);
  }

  private endChain(): void {
    this.chain = this.chainFirst = null;
    this.status();
    this.render();
  }

  private async typeLength(first: string): Promise<void> {
    if (!this.chain || !this.cursor) return;
    const from = this.chain;
    const dir = norm(sub(this.cursor.p, from));
    if (dir[0] === 0 && dir[1] === 0) return;
    const at = this.toScreen(this.cursor.p);
    const v = await this.ask.ask(t('ask.length'), at, first, t('ask.lengthHint'), false);
    const len = v === null ? null : parseLength(v);
    if (len === null || !this.chain) return;
    this.placeWallPoint(add(from, scale(dir, len)));
  }

  private placeWallPoint(p: Vec2): void {
    const from = this.chain;
    if (!from) { this.chain = this.chainFirst = p; this.status(); this.render(); return; }
    if (dist(from, p) < 0.02) return;
    const props = { thickness: this.opts.thickness, kind: this.opts.wallKind };
    this.store.edit((l) => addWall(l, from, p, props, this.tol));
    const closed = this.chainFirst && dist(p, this.chainFirst) < 1e-6;
    if (closed) this.endChain();
    else { this.chain = p; this.status(); }
  }

  // ---------------------------------------------------------------- underlay

  setUnderlay(u: UnderlayImage | null): void {
    if (this.underlay && this.underlay !== u) URL.revokeObjectURL(this.underlay.url);
    this.underlay = u;
    if (!u && (this.tool === 'calibrate' || this.tool === 'moveUnderlay')) this.setTool('select');
    this.render();
  }

  private underlayTransform(): UnderlayTransform | null {
    if (!this.underlay) return null;
    const tr = this.store.plan.source?.transform as UnderlayTransform | undefined;
    return tr ?? defaultTransform(this.underlay.width);
  }

  private underlayRect(): { min: Vec2; max: Vec2 } | null {
    const tr = this.underlayTransform();
    if (!tr || !this.underlay) return null;
    const x0 = tr[4], y1 = tr[5], x1 = tr[4] + tr[0] * this.underlay.width, y0 = tr[5] + tr[3] * this.underlay.height;
    return { min: [Math.min(x0, x1), Math.min(y0, y1)], max: [Math.max(x0, x1), Math.max(y0, y1)] };
  }

  private setTransform(tr: UnderlayTransform, live: boolean): void {
    const apply = () => {
      const p = this.store.plan;
      p.source = { ...(p.source ?? {}), transform: tr };
    };
    if (live) this.store.live(apply);
    else this.store.edit(apply);
  }

  private async finishCalibration(): Promise<void> {
    const [p1, p2] = this.calib;
    const tr = this.underlayTransform();
    if (!tr || !p1 || !p2) return;
    const measured = dist(p1, p2);
    const at = this.toScreen(p2);
    const v = await this.ask.ask(t('ask.realLength'), at, '', t('ask.lengthHint'));
    this.calib = [];
    const len = v === null ? null : parseLength(v);
    if (len === null || measured < 1e-6) { this.render(); this.status(); return; }
    const k = len / measured;
    // scale about p1 so the first point stays where it is
    const next: UnderlayTransform = [tr[0] * k, 0, 0, tr[3] * k, p1[0] + (tr[4] - p1[0]) * k, p1[1] + (tr[5] - p1[1]) * k];
    this.setTransform(next, false);
    this.store.edit((_, plan) => { plan.source = { ...(plan.source ?? {}), metresPerUnit: next[0], calibrated: true }; });
    this.setTool('select');
    this.onCalibrated?.();
  }

  // ---------------------------------------------------------------- pointer

  private bindPointer(): void {
    const svg = this.svg;
    const local = (e: PointerEvent | MouseEvent): [number, number] => {
      const r = svg.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    svg.addEventListener('pointerenter', () => (this.pointerInside = true));
    svg.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this.cursor = null;
      this.hover = null;
      this.renderOverlay();
    });
    svg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.chain) this.endChain();
    });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      this.zoomAt(x, y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    }, { passive: false });
    svg.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (this.tool === 'wall' && this.chain) this.endChain();
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Alt') this.altKey = true; if (e.key === ' ' && this.pointerInside) { this.spaceKey = true; e.preventDefault(); } });
    window.addEventListener('keyup', (e) => { if (e.key === 'Alt') this.altKey = false; if (e.key === ' ') this.spaceKey = false; });

    svg.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // no text selection, no focus change by the browser: we focus the plan ourselves
      svg.focus({ preventScroll: true });
      const [x, y] = local(e);
      const p = this.toPlan(x, y);
      this.altKey = e.altKey;
      if (e.button === 1 || e.button === 2 || this.spaceKey) {
        this.drag = { kind: 'pan', last: [x, y] };
        svg.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      svg.setPointerCapture(e.pointerId);
      this.down(p, [x, y]);
    });
    svg.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      this.altKey = e.altKey;
      this.move(this.toPlan(x, y), [x, y]);
    });
    const up = (e: PointerEvent) => {
      const [x, y] = local(e);
      this.up(this.toPlan(x, y), [x, y]);
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
  }

  private snapFor(p: Vec2, except?: Set<string>): SnapResult {
    const from = this.chain ?? this.rectFrom ?? (this.tool === 'arc' && this.arcEnds.length === 1 ? this.arcEnds[0] : undefined);
    return snapPoint(this.store.level, p, { tol: this.tol, from: from ?? undefined, except, off: this.altKey });
  }

  private down(p: Vec2, px: [number, number]): void {
    const level = this.store.level;
    switch (this.tool) {
      case 'select': {
        const handle = this.curveHandleAt(px);
        if (handle) { this.drag = { kind: 'curve', id: handle, moved: false, start: px }; return; }
        const hit = this.hitTest(p);
        if (!hit) { this.store.select(null); this.drag = { kind: 'pan', last: px }; return; }
        if (hit.kind === 'loop') { this.store.select({ kind: 'loop', at: hit.at }); this.drag = { kind: 'pan', last: px }; return; }
        this.store.select(hit);
        if (hit.kind === 'node') this.drag = { kind: 'node', id: hit.id, moved: false, start: px };
        else if (hit.kind === 'opening') this.drag = { kind: 'opening', id: hit.id, moved: false, start: px };
        else if (hit.kind === 'room') this.drag = { kind: 'tag', id: hit.id, moved: false, start: px };
        else if (hit.kind === 'wall') {
          const w = wallById(level, hit.id)!;
          const e = wallEnds(level, w);
          this.drag = {
            kind: 'wall', id: hit.id, moved: false, start: px, from: p, normal: [-e.dir[1], e.dir[0]],
            ends: [{ id: w.a, p: e.a }, { id: w.b, p: e.b }],
          };
        }
        return;
      }
      case 'wall':
        this.placeWallPoint((this.cursor ?? this.snapFor(p)).p);
        return;
      case 'arc': {
        if (this.arcEnds.length < 2) {
          const q = (this.cursor ?? this.snapFor(p)).p;
          if (this.arcEnds.length === 1 && dist(q, this.arcEnds[0]) < 0.05) return;
          this.arcEnds.push(q);
        } else {
          const [a, b] = this.arcEnds;
          const sagitta = this.arcBow(a, b, p);
          const props = { thickness: this.opts.thickness, kind: this.opts.wallKind, sagitta };
          this.store.edit((l) => addWall(l, a, b, props, this.tol));
          this.arcEnds = [];
        }
        this.status();
        this.render();
        return;
      }
      case 'circle': {
        const q = (this.cursor ?? this.snapFor(p)).p;
        if (this.rectFrom) { this.commitCircle(this.rectFrom, p); return; }
        this.rectFrom = q;
        this.drag = { kind: 'circle', from: q, moved: false, start: px };
        return;
      }
      case 'rect': {
        const q = (this.cursor ?? this.snapFor(p)).p;
        if (this.rectFrom) { this.commitRect(this.rectFrom, q); return; }
        this.rectFrom = q;
        this.drag = { kind: 'rect', from: q, moved: false, start: px };
        return;
      }
      case 'door': case 'window': case 'slider': case 'passage': {
        const target = this.openingTarget(p);
        if (!target) return;
        const kind = OPENING_TOOLS[this.tool]!;
        const id = this.store.edit((l) => addOpening(l, target.wallId, target.u, kind, kind === 'door' ? { swing: target.side } : {}));
        this.store.select({ kind: 'opening', id });
        return;
      }
      case 'room': {
        const room = this.roomAt(p);
        if (room?.tag) { this.store.select({ kind: 'room', id: room.tag.id }); return; }
        const id = this.store.edit((l) => addRoomTag(l, p, this.opts.roomType));
        this.store.select({ kind: 'room', id });
        return;
      }
      case 'calibrate':
        this.calib.push(this.snapFor(p).kind === 'node' ? this.snapFor(p).p : p);
        if (this.calib.length >= 2) this.finishCalibration();
        this.status();
        this.render();
        return;
      case 'moveUnderlay':
        this.drag = { kind: 'underlay', last: p, moved: false };
        this.store.begin();
        return;
    }
  }

  private move(p: Vec2, px: [number, number]): void {
    this.rawCursor = p;
    const d = this.drag;
    if (d) {
      if (d.kind === 'pan') {
        this.view.cx -= (px[0] - d.last[0]) / this.view.s;
        this.view.cy += (px[1] - d.last[1]) / this.view.s;
        d.last = px;
        this.applyView();
        return;
      }
      if (d.kind === 'underlay') {
        const tr = this.underlayTransform()!;
        const dx = p[0] - d.last[0], dy = p[1] - d.last[1];
        d.last = p;
        d.moved = true;
        this.setTransform([tr[0], tr[1], tr[2], tr[3], tr[4] + dx, tr[5] + dy], true);
        return;
      }
      if ('start' in d && !d.moved && Math.hypot(px[0] - d.start[0], px[1] - d.start[1]) < DRAG_PX) return;
      if ('moved' in d && !d.moved) { d.moved = true; if (d.kind !== 'rect' && d.kind !== 'circle') this.store.begin(); }
      switch (d.kind) {
        case 'node': {
          const s = this.snapFor(p, new Set([d.id]));
          this.cursor = s;
          this.store.live((l) => moveNode(l, d.id, s.p));
          return;
        }
        case 'wall': {
          const off = dot(sub(p, d.from), d.normal);
          const r = (v: number) => (this.altKey ? v : Math.round(v * 100) / 100);
          const o = r(off);
          this.store.live((l) => { for (const e of d.ends) moveNode(l, e.id, add(e.p, scale(d.normal, o))); });
          return;
        }
        case 'opening': {
          const level = this.store.level;
          const o = level.openings.find((x) => x.id === d.id)!;
          const target = this.openingTarget(p) ?? this.projectOnWall(o.wall, p);
          if (target) this.store.live((l) => moveOpening(l, d.id, target.wallId, target.u));
          return;
        }
        case 'tag':
          this.store.live((l) => moveRoomTag(l, d.id, p));
          return;
        case 'rect':
          this.cursor = this.snapFor(p);
          this.renderOverlay();
          return;
        case 'circle':
          this.cursor = { p, kind: 'free', guides: [] };
          this.renderOverlay();
          return;
        case 'curve': {
          const level = this.store.level;
          const w = wallById(level, d.id);
          if (!w) return;
          const e = wallEnds(level, w);
          const mid = scale(add(e.a, e.b), 0.5);
          let bow = dot(sub(p, mid), [-e.dir[1], e.dir[0]]);
          if (!this.altKey) bow = Math.abs(bow) < this.tol ? 0 : Math.round(bow * 100) / 100;
          this.store.live((l) => {
            const x = wallById(l, d.id)!;
            if (bow) x.sagitta = bow; else delete x.sagitta;
          });
          return;
        }
      }
    }
    // no drag: hover and previews
    if (this.tool === 'select') {
      const h = this.hitTest(p);
      if (JSON.stringify(h) !== JSON.stringify(this.hover)) { this.hover = h; this.render(); }
      return;
    }
    if (this.tool === 'wall' || this.tool === 'rect' || this.tool === 'calibrate' || this.tool === 'circle' || (this.tool === 'arc' && this.arcEnds.length < 2)) this.cursor = this.snapFor(p);
    else this.cursor = null;
    this.renderOverlay();
  }

  private up(p: Vec2, px: [number, number]): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    switch (d.kind) {
      case 'node':
        if (d.moved) this.store.end((l) => settleNode(l, d.id, this.tol));
        break;
      case 'wall':
        if (d.moved) this.store.end((l) => { for (const e of d.ends) if (nodeById(l, e.id)) settleNode(l, e.id, this.tol); });
        break;
      case 'opening': case 'tag':
        if (d.moved) this.store.end();
        break;
      case 'curve':
        if (d.moved) this.store.end();
        else {
          this.store.select({ kind: 'wall', id: d.id });
        }
        break;
      case 'circle':
        if (d.moved && Math.hypot(px[0] - d.start[0], px[1] - d.start[1]) > 12) this.commitCircle(d.from, p);
        break;
      case 'rect':
        if (d.moved && Math.hypot(px[0] - d.start[0], px[1] - d.start[1]) > 12) this.commitRect(d.from, this.snapFor(p).p);
        break;
      case 'underlay':
        if (d.moved) this.store.end(); else this.store.cancel();
        break;
    }
    this.cursor = null;
    this.render();
  }

  /** The bow for the arc tool: through the cursor, or (Alt held) straight out from the middle. */
  private arcBow(a: Vec2, b: Vec2, p: Vec2): number {
    const s = sagittaThrough(a, b, p);
    return Math.abs(s) < this.tol ? 0 : Math.round(s * 1000) / 1000;
  }

  private commitCircle(c: Vec2, p: Vec2): void {
    this.rectFrom = null;
    const r = Math.round(dist(c, p) * 100) / 100;
    const props = { thickness: this.opts.thickness, kind: this.opts.wallKind };
    this.store.edit((l) => addCircle(l, c, r, props, this.tol));
    this.render();
  }

  /** The bow handle of the selected wall, when the pointer is on it. */
  private curveHandleAt(px: [number, number]): string | null {
    const s = this.store.selection;
    if (!s || s.kind !== 'wall') return null;
    const g = this.derive().idx.walls.get(s.id);
    if (!g || g.wall.kind === 'virtual') return null;
    const h = this.toScreen(fromWallLocal(g, g.length / 2, 0));
    return Math.hypot(h.x - px[0], h.y - px[1]) <= 9 ? s.id : null;
  }

  private commitRect(a: Vec2, b: Vec2): void {
    this.rectFrom = null;
    const props = { thickness: this.opts.thickness, kind: this.opts.wallKind };
    this.store.edit((l) => addRect(l, a, b, props, this.tol));
    this.render();
  }

  // ---------------------------------------------------------------- hit testing

  private derive(): Derived {
    const rev = this.store.revision;
    if (this.derived && this.derived.rev === rev && this.derived.idx.level === this.store.level) return this.derived;
    const idx = indexLevel(this.store.level);
    const footprints = wallFootprints(idx);
    const pieces = new Map<string, WallPieces>();
    for (const [id, fp] of footprints) pieces.set(id, wallPieces(idx, fp));
    const { rooms } = detectRooms(idx);
    this.derived = { rev, idx, footprints, pieces, rooms };
    return this.derived;
  }

  private roomAt(p: Vec2): Room | undefined {
    const rooms = this.derive().rooms.filter((r) => pointInPolygon(p, r.polygon));
    return rooms.sort((a, b) => a.area - b.area)[0];
  }

  private hitTest(p: Vec2): Hit | null {
    const level = this.store.level;
    const tol = this.tol;
    let best: { hit: Hit; d: number } | null = null;
    const consider = (hit: Hit, d: number) => { if (!best || d < best.d) best = { hit, d }; };
    for (const n of level.nodes) {
      const d = Math.hypot(n.x - p[0], n.y - p[1]);
      if (d < tol * 1.2) consider({ kind: 'node', id: n.id }, d - tol); // nodes win near their point
    }
    if (best) return (best as { hit: Hit }).hit;
    const { idx } = this.derive();
    for (const o of level.openings) {
      const g = idx.walls.get(o.wall);
      if (!g) continue;
      const f = wallFrame(g, o.offset);
      const v = sub(p, f.p);
      const along = Math.abs(dot(v, f.t)), across = Math.abs(dot(v, f.n));
      if (along <= o.width / 2 && across <= g.wall.thickness / 2 + tol) consider({ kind: 'opening', id: o.id }, across * 0.5);
    }
    if (best) return (best as { hit: Hit }).hit;
    for (const r of this.derive().rooms) {
      if (!r.tag) continue;
      const s = this.toScreen(r.labelAt), q = this.toScreen(p);
      if (Math.abs(s.x - q.x) < 36 && Math.abs(s.y - q.y) < 14) return { kind: 'room', id: r.tag.id };
    }
    for (const w of level.walls) {
      const g = idx.walls.get(w.id);
      if (!g) continue;
      const { d } = wallDistance(g, p);
      if (d <= w.thickness / 2 + tol * 0.6) consider({ kind: 'wall', id: w.id }, d);
    }
    if (best) return (best as { hit: Hit }).hit;
    const room = this.roomAt(p);
    if (room) return room.tag ? { kind: 'room', id: room.tag.id } : { kind: 'loop', at: p };
    return null;
  }

  /** The wall an opening tool would put an opening on, with position and the side the cursor is on. */
  private openingTarget(p: Vec2): { wallId: string; u: number; side: 'left' | 'right' } | null {
    const { idx } = this.derive();
    let best: { wallId: string; u: number; side: 'left' | 'right'; d: number } | null = null;
    for (const [id, g] of idx.walls) {
      if (g.wall.kind === 'virtual') continue;
      const { d, u } = wallDistance(g, p);
      if (d > g.wall.thickness / 2 + this.tol * 1.5) continue;
      if (!best || d < best.d) best = { wallId: id, u, side: toWallLocal(g, p)[1] >= 0 ? 'left' : 'right', d };
    }
    return best;
  }

  private projectOnWall(wallId: string, p: Vec2): { wallId: string; u: number } | null {
    const g = this.derive().idx.walls.get(wallId);
    if (!g) return null;
    return { wallId, u: Math.min(Math.max(wallParam(g, p), 0), g.length) };
  }

  // ---------------------------------------------------------------- drawing

  render(): void {
    const level = this.store.level;
    const { idx, pieces, rooms } = this.derive();
    const px = 1 / this.view.s; // one screen pixel in plan metres
    const L = this.layers;

    // underlay
    const tr = this.underlayTransform();
    if (this.underlay && tr && this.underlayVisible) {
      this.underImg.setAttribute('href', this.underlay.url);
      this.underImg.setAttribute('x', String(tr[4]));
      this.underImg.setAttribute('y', String(-tr[5]));
      this.underImg.setAttribute('width', String(tr[0] * this.underlay.width));
      this.underImg.setAttribute('height', String(-tr[3] * this.underlay.height));
      this.underImg.setAttribute('opacity', String(this.underlayOpacity));
      this.underImg.style.display = '';
    } else this.underImg.style.display = 'none';
    const tracing = !!this.underlay && this.underlayVisible;

    // rooms
    L.rooms.replaceChildren(...rooms.map((r) => {
      const path = el('path', { d: polyPath(r.polygon), fill: r.tag ? ROOM_FILL[r.type] : '#f4f1ec', class: r.tag ? 'room' : 'room room--untagged' });
      if (tracing) path.setAttribute('fill-opacity', '0.45');
      return path;
    }));

    // walls
    const wallEls: SVGElement[] = [];
    for (const w of level.walls) {
      const g = idx.walls.get(w.id);
      if (!g) continue;
      const lowConf = w.confidence !== undefined && w.confidence < 0.6;
      if (w.kind === 'virtual') {
        wallEls.push(el('path', { d: linePath(wallPolyline(g)), class: 'wall-virtual' }));
        continue;
      }
      const pc = pieces.get(w.id);
      if (!pc) continue;
      const cls = `wall wall--${w.kind}${lowConf ? ' low-conf' : ''}`;
      wallEls.push(el('path', { d: pc.solids.map(polyPath).join(' '), class: cls }));
      for (const gap of pc.gaps) if (gap.span.sill > 0.05) wallEls.push(el('path', { d: polyPath(gap.polygon), class: 'wall-gap' }));
    }
    L.walls.replaceChildren(...wallEls);

    // openings
    const openEls: SVGElement[] = [];
    for (const o of level.openings) {
      const g = idx.walls.get(o.wall);
      if (!g) continue;
      const h = g.wall.thickness / 2;
      const u0 = Math.max(0, o.offset - o.width / 2), u1 = Math.min(g.length, o.offset + o.width / 2);
      const P = (u: number, v: number) => fromWallLocal(g, u, v);
      const line = (a: Vec2, b: Vec2, cls: string) => el('line', { x1: a[0], y1: -a[1], x2: b[0], y2: -b[1], class: cls });
      if (o.kind === 'door' || o.kind === 'entry') {
        const side = (o.swing ?? 'left') === 'left' ? 1 : -1;
        const hu = (o.hinge ?? 'start') === 'start' ? u0 : u1, fu = hu === u0 ? u1 : u0;
        const H = P(hu, side * h), C = P(fu, side * h);
        const width = u1 - u0;
        const O = add(H, scale(wallFrame(g, hu).n, side * width));
        const sweep = crossZ(sub(O, H), sub(C, H)) > 0 ? 1 : 0;
        openEls.push(el('path', { d: `M${H[0]} ${-H[1]} L${O[0]} ${-O[1]} A${width} ${width} 0 0 ${sweep} ${C[0]} ${-C[1]}`, class: o.kind === 'entry' ? 'door door--entry' : 'door' }));
      } else if (o.kind === 'window') {
        openEls.push(line(P(u0, 0), P(u1, 0), 'glass'));
        openEls.push(line(P(u0, h * 0.4), P(u1, h * 0.4), 'glass glass--thin'));
        openEls.push(line(P(u0, -h * 0.4), P(u1, -h * 0.4), 'glass glass--thin'));
      } else if (o.kind === 'slider') {
        const m = (u0 + u1) / 2, lap = (u1 - u0) * 0.08;
        openEls.push(line(P(u0, h * 0.25), P(m + lap, h * 0.25), 'glass'));
        openEls.push(line(P(m - lap, -h * 0.25), P(u1, -h * 0.25), 'glass'));
      } else if (o.kind === 'passage') {
        openEls.push(line(P(u0, -h), P(u0, h), 'passage'));
        openEls.push(line(P(u1, -h), P(u1, h), 'passage'));
      }
      if (o.confidence !== undefined && o.confidence < 0.6) {
        const c = P(o.offset, 0);
        openEls.push(el('circle', { cx: c[0], cy: -c[1], r: o.width / 2 + 4 * px, class: 'low-conf-ring' }));
      }
    }
    L.openings.replaceChildren(...openEls);

    // room labels
    const fs = 12 * px;
    L.labels.setAttribute('font-size', String(fs));
    L.labels.replaceChildren(...rooms.map((r) => {
      const g = el('g', { class: r.tag ? 'label' : 'label label--untagged', transform: `translate(${r.labelAt[0]} ${-r.labelAt[1]})` });
      const name = el('text', { class: 'label__name', 'text-anchor': 'middle', y: -0.15 * fs });
      name.textContent = r.tag ? roomName(r) : t('room.unnamed');
      const area = el('text', { class: 'label__area', 'text-anchor': 'middle', y: 1.0 * fs, 'font-size': fs * 0.85 });
      area.textContent = t('unit.area', { v: formatNumber(r.area) });
      g.append(name, area);
      return g;
    }));

    // nodes (only while editing geometry)
    const showNodes = ['select', 'wall', 'arc', 'rect', 'circle'].includes(this.tool);
    L.nodes.replaceChildren(...(showNodes ? level.nodes.map((n) => el('circle', { cx: n.x, cy: -n.y, r: 2.5 * px, class: 'node' })) : []));

    this.renderSelection();
    this.renderOverlay();
  }

  private renderSelection(): void {
    const L = this.layers, level = this.store.level, px = 1 / this.view.s;
    const { idx, footprints, rooms } = this.derive();
    const out: SVGElement[] = [];
    const mark = (hit: Hit | null, cls: string) => {
      if (!hit) return;
      if (hit.kind === 'node') {
        const n = nodeById(level, hit.id);
        if (n) out.push(el('circle', { cx: n.x, cy: -n.y, r: 6 * px, class: cls }));
      } else if (hit.kind === 'wall') {
        const fp = footprints.get(hit.id);
        const g = idx.walls.get(hit.id);
        if (fp) out.push(el('path', { d: polyPath(fp.polygon), class: cls }));
        else if (g) out.push(el('path', { d: linePath(wallPolyline(g)), class: cls }));
        if (g && cls === 'sel') {
          // length along the wall
          const m = fromWallLocal(g, g.length / 2, g.wall.thickness / 2 + 14 * px);
          const tm = wallFrame(g, g.length / 2).t;
          let ang = (-Math.atan2(tm[1], tm[0]) * 180) / Math.PI;
          if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
          const txt = el('text', { class: 'dim', 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 11 * px, transform: `translate(${m[0]} ${-m[1]}) rotate(${ang})` });
          txt.textContent = g.arc ? `${formatNumber(g.length, 2)} m · R ${formatNumber(g.arc.radius, 2)}` : `${formatNumber(g.length, 2)} m`;
          out.push(txt);
          // the bow handle: drag to curve the wall
          if (g.wall.kind !== 'virtual') {
            const hpt = fromWallLocal(g, g.length / 2, 0);
            out.push(el('circle', { cx: hpt[0], cy: -hpt[1], r: 5 * px, class: 'curve-handle' }));
          }
        }
      } else if (hit.kind === 'opening') {
        const o = level.openings.find((x) => x.id === hit.id);
        const g = o && idx.walls.get(o.wall);
        if (o && g) {
          const h = g.wall.thickness / 2 + 3 * px;
          const u0 = o.offset - o.width / 2, u1 = o.offset + o.width / 2;
          const pts = [fromWallLocal(g, u0, -h), fromWallLocal(g, u1, -h), fromWallLocal(g, u1, h), fromWallLocal(g, u0, h)];
          out.push(el('path', { d: polyPath(pts), class: cls }));
        }
      } else if (hit.kind === 'room') {
        const r = rooms.find((x) => x.tag?.id === hit.id);
        if (r) out.push(el('path', { d: polyPath(r.polygon), class: `${cls} ${cls}--room` }));
        else {
          const tag = level.rooms.find((x) => x.id === hit.id);
          if (tag) out.push(el('circle', { cx: tag.at[0], cy: -tag.at[1], r: 6 * px, class: cls }));
        }
      } else if (hit.kind === 'loop') {
        const r = rooms.find((x) => !x.tag && pointInPolygon(hit.at, x.polygon));
        if (r) out.push(el('path', { d: polyPath(r.polygon), class: `${cls} ${cls}--room` }));
      }
    };
    if (this.tool === 'select' && !this.drag) mark(this.hover, 'hover');
    mark(this.store.selection as Hit | null, 'sel');
    L.select.replaceChildren(...out);
  }

  private renderOverlay(): void {
    const L = this.layers, px = 1 / this.view.s;
    const out: SVGElement[] = [];
    const c = this.cursor;
    if (c) {
      for (const g of c.guides) out.push(el('line', { x1: g.from[0], y1: -g.from[1], x2: g.to[0], y2: -g.to[1], class: 'guide' }));
      const cls = `snap snap--${c.kind}`;
      if (c.kind === 'node') out.push(el('circle', { cx: c.p[0], cy: -c.p[1], r: 6 * px, class: cls }));
      else if (c.kind === 'wall') out.push(el('rect', { x: c.p[0] - 4 * px, y: -c.p[1] - 4 * px, width: 8 * px, height: 8 * px, class: cls, transform: `rotate(45 ${c.p[0]} ${-c.p[1]})` }));
      else out.push(el('circle', { cx: c.p[0], cy: -c.p[1], r: 3 * px, class: cls }));
    }
    const fs = 11 * px;
    const label = (p: Vec2, text: string) => {
      const tx = el('text', { x: p[0] + 10 * px, y: -p[1] - 10 * px, class: 'dim dim--live', 'font-size': fs });
      tx.textContent = text;
      out.push(tx);
    };
    if (this.tool === 'wall' && this.chain && c) {
      const a = this.chain, b = c.p;
      const half = this.opts.thickness / 2;
      const d = norm(sub(b, a)), n: Vec2 = [-d[1] * half, d[0] * half];
      if (dist(a, b) > 1e-4) out.push(el('path', { d: polyPath([add(a, n), add(b, n), sub(b, n), sub(a, n)]), class: 'preview' }));
      out.push(el('line', { x1: a[0], y1: -a[1], x2: b[0], y2: -b[1], class: 'preview-line' }));
      label(b, `${formatNumber(dist(a, b), 2)} m`);
    }
    if (this.tool === 'arc' && this.arcEnds.length) {
      const [a, b] = this.arcEnds;
      const end = b ?? c?.p;
      if (end && dist(a, end) > 1e-4) {
        const bow = b && this.rawCursor ? this.arcBow(a, b, this.rawCursor) : 0;
        const arc = arcFromSagitta(a, end, bow);
        const pts: Vec2[] = arc ? Array.from({ length: arcSegments(arc) + 1 }, (_, i) => arcPoint(arc, (arc.length * i) / arcSegments(arc))) : [a, end];
        out.push(el('path', { d: bandPath(pts, this.opts.thickness / 2), class: 'preview' }));
        out.push(el('path', { d: linePath(pts), class: 'preview-line' }));
        label(b ? this.rawCursor ?? end : end, arc ? `${formatNumber(arc.length, 2)} m · R ${formatNumber(arc.radius, 2)}` : `${formatNumber(dist(a, end), 2)} m`);
      }
    }
    if (this.tool === 'circle' && this.rectFrom && c) {
      const r = dist(this.rectFrom, c.p);
      out.push(el('circle', { cx: this.rectFrom[0], cy: -this.rectFrom[1], r, class: 'preview preview--rect' }));
      out.push(el('circle', { cx: this.rectFrom[0], cy: -this.rectFrom[1], r: 3 * px, class: 'snap snap--free' }));
      label(c.p, `R ${formatNumber(r, 2)} m · ⌀ ${formatNumber(2 * r, 2)} m`);
    }
    if (this.tool === 'rect' && this.rectFrom && c) {
      const a = this.rectFrom, b = c.p;
      out.push(el('path', { d: polyPath([a, [b[0], a[1]], b, [a[0], b[1]]]), class: 'preview preview--rect' }));
      label(b, `${formatNumber(Math.abs(b[0] - a[0]), 2)} × ${formatNumber(Math.abs(b[1] - a[1]), 2)} m`);
    }
    if (OPENING_TOOLS[this.tool] && this.rawCursor) {
      const target = this.openingTarget(this.rawCursor);
      const g = target && this.derive().idx.walls.get(target.wallId);
      if (target && g) {
        const kind = OPENING_TOOLS[this.tool]!;
        const w = Math.min(OPENING_WIDTHS[kind], g.length - 0.1);
        const u = Math.min(Math.max(target.u, 0.05 + w / 2), g.length - 0.05 - w / 2);
        const h = g.wall.thickness / 2 + 2 * px;
        out.push(el('path', { d: polyPath([fromWallLocal(g, u - w / 2, -h), fromWallLocal(g, u + w / 2, -h), fromWallLocal(g, u + w / 2, h), fromWallLocal(g, u - w / 2, h)]), class: 'preview preview--opening' }));
      }
    }
    if (this.tool === 'calibrate') {
      const pts = [...this.calib, ...(this.calib.length === 1 && c ? [c.p] : [])];
      for (const p of pts) out.push(el('circle', { cx: p[0], cy: -p[1], r: 4 * px, class: 'calib' }));
      if (pts.length === 2) {
        out.push(el('line', { x1: pts[0][0], y1: -pts[0][1], x2: pts[1][0], y2: -pts[1][1], class: 'calib-line' }));
        label(pts[1], `${formatNumber(dist(pts[0], pts[1]), 2)} m ${t('hint.uncalibrated')}`);
      }
    }
    L.over.replaceChildren(...out);
  }
}

// ---------------------------------------------------------------- helpers

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function linePath(pts: Vec2[]): string {
  return pts.length ? `M${pts.map((p) => `${r4(p[0])} ${r4(-p[1])}`).join('L')}` : '';
}

/** Outline of a band of half-width h along a polyline. */
function bandPath(pts: Vec2[], h: number): string {
  const left: Vec2[] = [], right: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const d = norm(sub(b, a)), n: Vec2 = [-d[1] * h, d[0] * h];
    left.push(add(pts[i], n));
    right.push(sub(pts[i], n));
  }
  return polyPath([...left, ...right.reverse()]);
}

function polyPath(poly: Vec2[]): string {
  return poly.length ? `M${poly.map((p) => `${r4(p[0])} ${r4(-p[1])}`).join('L')}Z` : '';
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const crossZ = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];

const DELETE = { node: deleteNode, wall: deleteWall, opening: deleteOpening, room: deleteRoomTag } as const;

function deleteSelected(level: Level, kind: keyof typeof DELETE, id: string): void {
  DELETE[kind](level, id);
}
