// Editing operations on a level. Every operation mutates the level it is given; the editor works
// on a copy and keeps the previous copies for undo. All lengths are metres.
import {
  type Level, type Opening, type OpeningKind, type PlanNode, type RoomTag, type RoomType, type Vec2,
  type Wall, type WallKind,
} from './plan';
import { add, closestOnSegment, cross, dist, dot, norm, scale, sub } from './geometry';

export interface WallProps {
  thickness: number;
  kind: WallKind;
  height?: number;
}

export const WALL_PRESETS: Record<WallKind, number> = {
  exterior: 0.25,
  interior: 0.12,
  partition: 0.08,
  structural: 0.3,
  railing: 0.08,
  virtual: 0.02,
};

export const OPENING_WIDTHS: Record<OpeningKind, number> = {
  door: 0.85,
  entry: 1.0,
  window: 1.2,
  slider: 2.4,
  passage: 0.9,
};

/** Gap kept between an opening and the end of its wall. */
const END_MARGIN = 0.05;

// ---------------------------------------------------------------- ids and lookups

export function newId(level: Level, prefix: string): string {
  const used = new Set<string>([
    ...level.nodes.map((n) => n.id), ...level.walls.map((w) => w.id),
    ...level.openings.map((o) => o.id), ...level.rooms.map((r) => r.id),
  ]);
  let i = 1;
  while (used.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

export const nodeById = (level: Level, id: string) => level.nodes.find((n) => n.id === id);
export const wallById = (level: Level, id: string) => level.walls.find((w) => w.id === id);
export const openingById = (level: Level, id: string) => level.openings.find((o) => o.id === id);
export const roomById = (level: Level, id: string) => level.rooms.find((r) => r.id === id);

export function nodePos(level: Level, id: string): Vec2 {
  const n = nodeById(level, id)!;
  return [n.x, n.y];
}

export function wallEnds(level: Level, w: Wall): { a: Vec2; b: Vec2; len: number; dir: Vec2 } {
  const a = nodePos(level, w.a), b = nodePos(level, w.b);
  return { a, b, len: dist(a, b), dir: norm(sub(b, a)) };
}

export function wallsAt(level: Level, nodeId: string): Wall[] {
  return level.walls.filter((w) => w.a === nodeId || w.b === nodeId);
}

/** Nearest node within tol. */
export function findNode(level: Level, p: Vec2, tol: number, except?: Set<string>): PlanNode | undefined {
  let best: PlanNode | undefined, bestD = tol;
  for (const n of level.nodes) {
    if (except?.has(n.id)) continue;
    const d = Math.hypot(n.x - p[0], n.y - p[1]);
    if (d <= bestD) { best = n; bestD = d; }
  }
  return best;
}

/** Nearest wall centre-line within tol, with the position along it (u) and the closest point. */
export function findWall(level: Level, p: Vec2, tol: number, except?: Set<string>): { wall: Wall; u: number; point: Vec2; d: number } | undefined {
  let best: { wall: Wall; u: number; point: Vec2; d: number } | undefined;
  for (const w of level.walls) {
    if (except?.has(w.id)) continue;
    const { a, b, dir } = wallEnds(level, w);
    const { point, d } = closestOnSegment(p, a, b);
    if (d <= tol && (!best || d < best.d)) best = { wall: w, u: dot(sub(point, a), dir), point, d };
  }
  return best;
}

// ---------------------------------------------------------------- nodes

export function addNode(level: Level, p: Vec2): string {
  const id = newId(level, 'n');
  level.nodes.push({ id, x: round(p[0]), y: round(p[1]) });
  return id;
}

/** Splits a wall at distance u from its start; returns the new node. Openings go to whichever half holds their centre. */
export function splitWall(level: Level, wallId: string, u: number): string {
  const w = wallById(level, wallId)!;
  const { a, len, dir } = wallEnds(level, w);
  u = Math.min(Math.max(u, 0.001), len - 0.001);
  const node = addNode(level, add(a, scale(dir, u)));
  const second: Wall = { ...w, id: newId(level, 'w'), a: node, b: w.b };
  w.b = node;
  level.walls.push(second);
  for (const o of level.openings) {
    if (o.wall !== w.id || o.offset <= u) continue;
    o.wall = second.id;
    o.offset -= u;
  }
  for (const o of level.openings) if (o.wall === w.id || o.wall === second.id) clampOpening(level, o);
  return node;
}

/** A node at p: an existing one nearby, a split of a wall passing nearby, or a new one. */
export function ensureNode(level: Level, p: Vec2, tol: number): string {
  const n = findNode(level, p, tol);
  if (n) return n.id;
  const hit = findWall(level, p, tol);
  if (hit) {
    const { len } = wallEnds(level, hit.wall);
    if (hit.u < tol) return hit.wall.a;
    if (hit.u > len - tol) return hit.wall.b;
    return splitWall(level, hit.wall.id, hit.u);
  }
  return addNode(level, p);
}

export function moveNode(level: Level, id: string, p: Vec2): void {
  const n = nodeById(level, id);
  if (!n) return;
  n.x = round(p[0]);
  n.y = round(p[1]);
  for (const w of wallsAt(level, id)) for (const o of level.openings) if (o.wall === w.id) clampOpening(level, o);
}

/** Joins node `drop` into node `keep`: its walls are reconnected; walls that collapse or double up are removed. */
export function mergeNodes(level: Level, keep: string, drop: string): void {
  if (keep === drop) return;
  for (const w of level.walls) {
    if (w.a === drop) w.a = keep;
    if (w.b === drop) w.b = keep;
  }
  level.nodes = level.nodes.filter((n) => n.id !== drop);
  removeDegenerateWalls(level);
}

/** After a node was dragged: join it to a node it landed on, or split a wall it landed on. */
export function settleNode(level: Level, id: string, tol: number): string {
  const p = nodePos(level, id);
  const other = findNode(level, p, tol, new Set([id]));
  if (other) {
    mergeNodes(level, other.id, id);
    return other.id;
  }
  const own = new Set(wallsAt(level, id).map((w) => w.id));
  const hit = findWall(level, p, tol, own);
  if (hit) {
    const { len } = wallEnds(level, hit.wall);
    if (hit.u > tol && hit.u < len - tol) {
      const n = splitWall(level, hit.wall.id, hit.u);
      mergeNodes(level, n, id);
      return n;
    }
  }
  splitCrossings(level);
  return id;
}

// ---------------------------------------------------------------- walls

/**
 * Adds a wall from p to q. End points snap to nodes or split walls they land on; the new wall is
 * split where it crosses existing walls or passes through existing nodes. Returns the new wall ids.
 */
export function addWall(level: Level, p: Vec2, q: Vec2, props: WallProps, tol: number): string[] {
  const a = ensureNode(level, p, tol);
  const b = ensureNode(level, q, tol);
  if (a === b) return [];
  const pa = nodePos(level, a), pb = nodePos(level, b);
  const len = dist(pa, pb);
  if (len < 0.02) return [];
  const dir = norm(sub(pb, pa));

  // stops along the new wall: existing nodes on it and crossings with existing walls
  const stops: { t: number; node: string }[] = [{ t: 0, node: a }, { t: len, node: b }];
  for (const n of level.nodes) {
    if (n.id === a || n.id === b) continue;
    const v = sub([n.x, n.y], pa);
    const t = dot(v, dir);
    if (t > tol && t < len - tol && Math.abs(cross(dir, v)) < tol * 0.5) stops.push({ t, node: n.id });
  }
  for (const w of [...level.walls]) {
    if ([w.a, w.b].some((x) => x === a || x === b)) continue;
    const e = wallEnds(level, w);
    const hit = segmentHit(pa, pb, e.a, e.b);
    if (!hit) continue;
    const [t, s] = hit;
    if (t * len < tol || (1 - t) * len < tol || s * e.len < tol || (1 - s) * e.len < tol) continue;
    const node = splitWall(level, w.id, s * e.len);
    stops.push({ t: t * len, node });
  }
  stops.sort((x, y) => x.t - y.t);
  const ids: string[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const n0 = stops[i].node, n1 = stops[i + 1].node;
    if (n0 === n1) continue;
    if (level.walls.some((w) => (w.a === n0 && w.b === n1) || (w.a === n1 && w.b === n0))) continue;
    const id = newId(level, 'w');
    const wall: Wall = { id, a: n0, b: n1, thickness: props.thickness, kind: props.kind };
    if (props.height !== undefined) wall.height = props.height;
    level.walls.push(wall);
    ids.push(id);
  }
  return ids;
}

/** Four walls around the rectangle with corners p and q. */
export function addRect(level: Level, p: Vec2, q: Vec2, props: WallProps, tol: number): string[] {
  const c: Vec2[] = [[p[0], p[1]], [q[0], p[1]], [q[0], q[1]], [p[0], q[1]]];
  if (Math.abs(q[0] - p[0]) < 0.1 || Math.abs(q[1] - p[1]) < 0.1) return [];
  return c.flatMap((pt, i) => addWall(level, pt, c[(i + 1) % 4], props, tol));
}

/** Moves a wall sideways by d (positive to the left of a → b), dragging the walls joined to it. */
export function pushWall(level: Level, wallId: string, d: number): void {
  const w = wallById(level, wallId);
  if (!w) return;
  const { dir } = wallEnds(level, w);
  const off = scale([-dir[1], dir[0]], d);
  for (const id of [w.a, w.b]) {
    const n = nodeById(level, id)!;
    moveNode(level, id, add([n.x, n.y], off));
  }
}

export function deleteWall(level: Level, wallId: string): void {
  const w = wallById(level, wallId);
  if (!w) return;
  level.walls = level.walls.filter((x) => x.id !== wallId);
  level.openings = level.openings.filter((o) => o.wall !== wallId);
  for (const n of [w.a, w.b]) healNode(level, n);
  removeOrphanNodes(level);
}

export function deleteNode(level: Level, nodeId: string): void {
  for (const w of wallsAt(level, nodeId)) {
    level.walls = level.walls.filter((x) => x.id !== w.id);
    level.openings = level.openings.filter((o) => o.wall !== w.id);
  }
  level.nodes = level.nodes.filter((n) => n.id !== nodeId);
  for (const n of level.nodes) healNode(level, n.id);
  removeOrphanNodes(level);
}

/** A node joining exactly two straight-on walls of the same kind is dissolved into one wall. */
export function healNode(level: Level, nodeId: string): void {
  const ws = wallsAt(level, nodeId);
  if (ws.length !== 2) return;
  const [w1, w2] = ws;
  if (w1.kind !== w2.kind || Math.abs(w1.thickness - w2.thickness) > 1e-6 || w1.height !== w2.height) return;
  const far1 = w1.a === nodeId ? w1.b : w1.a, far2 = w2.a === nodeId ? w2.b : w2.a;
  if (far1 === far2) return;
  const p = nodePos(level, far1), m = nodePos(level, nodeId), q = nodePos(level, far2);
  const d1 = norm(sub(m, p)), d2 = norm(sub(q, m));
  if (Math.abs(cross(d1, d2)) > 1e-3 || dot(d1, d2) < 0) return;
  // openings keep their place in the plan
  const centres = level.openings
    .filter((o) => o.wall === w1.id || o.wall === w2.id)
    .map((o) => ({ o, c: openingCentre(level, o) }));
  w1.a = far1;
  w1.b = far2;
  level.walls = level.walls.filter((x) => x.id !== w2.id);
  level.nodes = level.nodes.filter((n) => n.id !== nodeId);
  const dir = norm(sub(q, p));
  for (const { o, c } of centres) {
    o.wall = w1.id;
    o.offset = round(dot(sub(c, p), dir));
  }
}

function removeOrphanNodes(level: Level): void {
  const used = new Set(level.walls.flatMap((w) => [w.a, w.b]));
  level.nodes = level.nodes.filter((n) => used.has(n.id));
}

function removeDegenerateWalls(level: Level): void {
  const seen = new Set<string>();
  const drop = new Set<string>();
  for (const w of level.walls) {
    const key = [w.a, w.b].sort().join('|');
    if (w.a === w.b || seen.has(key)) drop.add(w.id);
    seen.add(key);
  }
  level.walls = level.walls.filter((w) => !drop.has(w.id));
  level.openings = level.openings.filter((o) => !drop.has(o.wall));
}

/** Splits every pair of walls that cross without a shared node (after moving things around). */
export function splitCrossings(level: Level): void {
  for (let guard = 0; guard < 200; guard++) {
    let found = false;
    outer: for (let i = 0; i < level.walls.length; i++) {
      for (let j = i + 1; j < level.walls.length; j++) {
        const A = level.walls[i], B = level.walls[j];
        if (A.kind === 'virtual' && B.kind === 'virtual') continue;
        if ([A.a, A.b].some((x) => x === B.a || x === B.b)) continue;
        const ea = wallEnds(level, A), eb = wallEnds(level, B);
        const hit = segmentHit(ea.a, ea.b, eb.a, eb.b);
        if (!hit) continue;
        const [t, s] = hit;
        if (t * ea.len < 0.01 || (1 - t) * ea.len < 0.01 || s * eb.len < 0.01 || (1 - s) * eb.len < 0.01) continue;
        const n = splitWall(level, A.id, t * ea.len);
        const m = splitWall(level, B.id, s * eb.len);
        mergeNodes(level, n, m);
        found = true;
        break outer;
      }
    }
    if (!found) return;
  }
}

function segmentHit(a: Vec2, b: Vec2, c: Vec2, d: Vec2): [number, number] | null {
  const r = sub(b, a), s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(c, a), s) / den, u = cross(sub(c, a), r) / den;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return [t, u];
}

// ---------------------------------------------------------------- openings

export function openingCentre(level: Level, o: Opening): Vec2 {
  const w = wallById(level, o.wall)!;
  const { a, dir } = wallEnds(level, w);
  return add(a, scale(dir, o.offset));
}

/** Keeps an opening inside its wall, shrinking it if the wall is too short. */
export function clampOpening(level: Level, o: Opening): void {
  const w = wallById(level, o.wall);
  if (!w) return;
  const { len } = wallEnds(level, w);
  const room = Math.max(0.1, len - 2 * END_MARGIN);
  if (o.width > room) o.width = round(room);
  const lo = END_MARGIN + o.width / 2, hi = len - END_MARGIN - o.width / 2;
  o.offset = round(lo > hi ? len / 2 : Math.min(Math.max(o.offset, lo), hi));
}

export function addOpening(
  level: Level, wallId: string, u: number, kind: OpeningKind,
  extra: Partial<Pick<Opening, 'width' | 'sill' | 'head' | 'hinge' | 'swing'>> = {},
): string {
  const id = newId(level, kind === 'window' ? 'win' : kind === 'slider' ? 'sl' : kind === 'passage' ? 'p' : 'd');
  const o: Opening = { id, wall: wallId, offset: u, width: extra.width ?? OPENING_WIDTHS[kind], kind };
  if (kind === 'door' || kind === 'entry') {
    o.hinge = extra.hinge ?? 'start';
    o.swing = extra.swing ?? 'left';
  }
  if (extra.sill !== undefined) o.sill = extra.sill;
  if (extra.head !== undefined) o.head = extra.head;
  level.openings.push(o);
  clampOpening(level, o);
  return id;
}

export function moveOpening(level: Level, id: string, wallId: string, u: number): void {
  const o = openingById(level, id);
  if (!o) return;
  o.wall = wallId;
  o.offset = u;
  clampOpening(level, o);
}

export function deleteOpening(level: Level, id: string): void {
  level.openings = level.openings.filter((o) => o.id !== id);
}

// ---------------------------------------------------------------- room names

export function addRoomTag(level: Level, p: Vec2, type: RoomType, name?: string): string {
  const id = newId(level, 'r');
  const tag: RoomTag = { id, type, at: [round(p[0]), round(p[1])] };
  if (name) tag.name = name;
  level.rooms.push(tag);
  return id;
}

export function moveRoomTag(level: Level, id: string, p: Vec2): void {
  const r = roomById(level, id);
  if (r) r.at = [round(p[0]), round(p[1])];
}

export function deleteRoomTag(level: Level, id: string): void {
  level.rooms = level.rooms.filter((r) => r.id !== id);
}

/** Millimetre precision keeps files tidy without losing anything visible. */
export function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
