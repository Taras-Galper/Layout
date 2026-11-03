// Level topology: resolved wall geometry, wall footprints with mitred joints, and room loops.
import {
  type Level, type Opening, type RoomTag, type RoomType, type Vec2, type Wall,
  openingHead, openingSill, wallHeight,
} from './plan';
import {
  add, clipPolygon, closestOnSegment, dist, dot, lineIntersect, norm, perpLeft, pointInPolygon,
  polygonArea, polygonCentroid, scale, sub,
} from './geometry';

export interface WallGeom {
  wall: Wall;
  a: Vec2;
  b: Vec2;
  /** Unit direction a → b. */
  dir: Vec2;
  /** Unit normal to the left of a → b. */
  left: Vec2;
  length: number;
  height: number;
}

export interface LevelIndex {
  level: Level;
  nodes: Map<string, Vec2>;
  walls: Map<string, WallGeom>;
  openingsByWall: Map<string, Opening[]>;
}

export function indexLevel(level: Level): LevelIndex {
  const nodes = new Map<string, Vec2>();
  for (const n of level.nodes) nodes.set(n.id, [n.x, n.y]);
  const walls = new Map<string, WallGeom>();
  for (const w of level.walls) {
    const a = nodes.get(w.a), b = nodes.get(w.b);
    if (!a || !b) continue;
    const length = dist(a, b);
    if (length < 1e-6) continue;
    const dir = norm(sub(b, a));
    walls.set(w.id, { wall: w, a, b, dir, left: perpLeft(dir), length, height: wallHeight(w, level) });
  }
  const openingsByWall = new Map<string, Opening[]>();
  for (const o of level.openings) {
    if (!walls.has(o.wall)) continue;
    const list = openingsByWall.get(o.wall) ?? [];
    list.push(o);
    openingsByWall.set(o.wall, list);
  }
  for (const list of openingsByWall.values()) list.sort((p, q) => p.offset - q.offset);
  return { level, nodes, walls, openingsByWall };
}

// ---------------------------------------------------------------- wall footprints

export interface WallFootprint {
  geom: WallGeom;
  /** Counter-clockwise outline of the wall seen from above, joints included. */
  polygon: Vec2[];
}

/**
 * Outline of every (non-virtual) wall with mitred joints. At each node the walls are sorted by angle;
 * neighbouring walls' side lines are intersected, and the node itself closes each wall end, so walls
 * meeting at any angle and any count fit together without gaps or overlaps.
 */
export function wallFootprints(idx: LevelIndex): Map<string, WallFootprint> {
  type End = { id: string; away: Vec2; h: number; angle: number };
  const ends = new Map<string, End[]>();
  for (const [id, g] of idx.walls) {
    if (g.wall.kind === 'virtual') continue;
    const h = g.wall.thickness / 2;
    const push = (node: string, away: Vec2) => {
      const list = ends.get(node) ?? [];
      list.push({ id, away, h, angle: Math.atan2(away[1], away[0]) });
      ends.set(node, list);
    };
    push(g.wall.a, g.dir);
    push(g.wall.b, scale(g.dir, -1));
  }

  // corner points per (node, wall): left / right relative to the direction pointing away from the node
  const corner = new Map<string, { l: Vec2; r: Vec2 }>();
  for (const [node, list] of ends) {
    const p = idx.nodes.get(node)!;
    list.sort((u, v) => u.angle - v.angle);
    const n = list.length;
    const leftLine = (e: End) => add(p, scale(perpLeft(e.away), e.h));
    const rightLine = (e: End) => add(p, scale(perpLeft(e.away), -e.h));
    const meet = (e: End, f: End): Vec2 => {
      // e's left side against f's right side (f is the next wall counter-clockwise)
      if (n === 1) return leftLine(e);
      const x = lineIntersect(leftLine(e), e.away, rightLine(f), f.away);
      const fallback = scale(add(leftLine(e), rightLine(f)), 0.5);
      if (!x) return fallback;
      const limit = 4 * Math.max(e.h, f.h);
      return dist(x, p) > limit ? fallback : x;
    };
    for (let i = 0; i < n; i++) {
      const e = list[i], next = list[(i + 1) % n], prev = list[(i - 1 + n) % n];
      const l = meet(e, next);
      const r = n === 1 ? rightLine(e) : meet(prev, e);
      corner.set(`${node}|${e.id}`, { l, r });
    }
  }

  const out = new Map<string, WallFootprint>();
  for (const [id, g] of idx.walls) {
    if (g.wall.kind === 'virtual') continue;
    const ca = corner.get(`${g.wall.a}|${id}`)!, cb = corner.get(`${g.wall.b}|${id}`)!;
    // at a the away direction is a→b; at b it is reversed, so its left is the a→b right side
    const polygon: Vec2[] = [ca.r, cb.l, g.b, cb.r, ca.l, g.a];
    out.set(id, { geom: g, polygon: dedupe(polygon) });
  }
  return out;
}

function dedupe(poly: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of poly) if (!out.length || dist(out[out.length - 1], p) > 1e-6) out.push(p);
  if (out.length > 1 && dist(out[0], out[out.length - 1]) < 1e-6) out.pop();
  return out;
}

/** Position of a point along a wall (u) and across it (v, positive to the left). */
export function toWallLocal(g: WallGeom, p: Vec2): Vec2 {
  const d = sub(p, g.a);
  return [dot(d, g.dir), dot(d, g.left)];
}

export function fromWallLocal(g: WallGeom, u: number, v: number): Vec2 {
  return add(add(g.a, scale(g.dir, u)), scale(g.left, v));
}

/** Openings of a wall as [start, end] intervals along it, clamped to the wall. */
export function openingSpans(idx: LevelIndex, wallId: string) {
  const g = idx.walls.get(wallId)!;
  return (idx.openingsByWall.get(wallId) ?? []).map((o) => ({
    opening: o,
    u0: Math.max(0, o.offset - o.width / 2),
    u1: Math.min(g.length, o.offset + o.width / 2),
    sill: openingSill(o),
    head: openingHead(o, g.height),
  }));
}

// ---------------------------------------------------------------- rooms

export interface Room {
  /** Tag id when tagged, otherwise a generated id. */
  id: string;
  tag?: RoomTag;
  type: RoomType;
  name?: string;
  /** Loop of wall centre-lines, counter-clockwise. */
  polygon: Vec2[];
  /** Loop shrunk to the inside faces of the walls. */
  inner: Vec2[];
  /** Floor area inside the walls, m². */
  area: number;
  /** Where to put the label. */
  labelAt: Vec2;
  wallIds: string[];
}

/**
 * Rooms are the bounded faces of the planar wall graph. Faces are traced by always taking the
 * next wall clockwise at each node, which walks every bounded face counter-clockwise.
 */
export interface RoomResult {
  rooms: Room[];
  /** Outer boundaries of connected wall groups (counter-clockwise, wall centre-lines). */
  outlines: Vec2[][];
  untagged: number;
  orphanTags: RoomTag[];
}

export function detectRooms(idx: LevelIndex): RoomResult {
  type HE = { from: string; to: string; wall: string; angle: number };
  const out = new Map<string, HE[]>();
  for (const [id, g] of idx.walls) {
    const a = g.wall.a, b = g.wall.b;
    (out.get(a) ?? out.set(a, []).get(a)!).push({ from: a, to: b, wall: id, angle: Math.atan2(g.dir[1], g.dir[0]) });
    (out.get(b) ?? out.set(b, []).get(b)!).push({ from: b, to: a, wall: id, angle: Math.atan2(-g.dir[1], -g.dir[0]) });
  }
  for (const list of out.values()) list.sort((p, q) => p.angle - q.angle);

  const key = (h: HE) => `${h.from}>${h.to}>${h.wall}`;
  const seen = new Set<string>();
  const faces: { nodes: string[]; walls: string[] }[] = [];
  for (const list of out.values()) {
    for (const start of list) {
      if (seen.has(key(start))) continue;
      const nodes: string[] = [], walls: string[] = [];
      let h = start, guard = 0;
      while (!seen.has(key(h)) && guard++ < 10000) {
        seen.add(key(h));
        nodes.push(h.from);
        walls.push(h.wall);
        const around = out.get(h.to)!;
        const back = around.findIndex((x) => x.to === h.from && x.wall === h.wall);
        h = around[(back - 1 + around.length) % around.length];
      }
      faces.push({ nodes, walls });
    }
  }

  const tags = [...idx.level.rooms];
  const used = new Set<string>();
  const rooms: Room[] = [];
  const outlines: Vec2[][] = [];
  let untagged = 0;
  for (const f of faces) {
    const polygon = f.nodes.map((n) => idx.nodes.get(n)!);
    const signed = polygonArea(polygon);
    if (signed < -0.05) { outlines.push([...polygon].reverse()); continue; } // outside of a wall group
    if (signed <= 0.05) continue; // slivers and dangling walls
    const inner = insetLoop(idx, f.nodes, f.walls);
    const tag = tags.find((t) => !used.has(t.id) && pointInPolygon(t.at, polygon));
    if (tag) used.add(tag.id); else untagged++;
    rooms.push({
      id: tag?.id ?? `room-${rooms.length + 1}`,
      tag,
      type: tag?.type ?? 'other',
      name: tag?.name,
      polygon,
      inner,
      area: Math.max(0, polygonArea(inner)),
      labelAt: tag?.at ?? labelPoint(polygon),
      wallIds: [...new Set(f.walls)],
    });
  }
  return { rooms, outlines, untagged, orphanTags: tags.filter((t) => !used.has(t.id)) };
}

/** Shrink a face loop by half of each wall's thickness (virtual walls have none). */
function insetLoop(idx: LevelIndex, nodes: string[], walls: string[]): Vec2[] {
  const n = nodes.length;
  const lines = walls.map((w, i) => {
    const g = idx.walls.get(w)!;
    const p = idx.nodes.get(nodes[i])!, q = idx.nodes.get(nodes[(i + 1) % n])!;
    const d = norm(sub(q, p));
    const h = g.wall.kind === 'virtual' ? 0 : g.wall.thickness / 2;
    return { p: add(p, scale(perpLeft(d), h)), d, h };
  });
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i - 1 + n) % n], cur = lines[i];
    const node = idx.nodes.get(nodes[i])!;
    const x = lineIntersect(prev.p, prev.d, cur.p, cur.d);
    if (x && dist(x, node) < 4 * Math.max(prev.h, cur.h, 0.01)) pts.push(x);
    else if (dot(prev.d, cur.d) < -0.99) {
      // a dead-end wall poking into the room: go around its end
      pts.push(add(node, scale(perpLeft(prev.d), prev.h)), add(node, scale(perpLeft(cur.d), cur.h)));
    } else pts.push(add(node, scale(perpLeft(cur.d), cur.h)));
  }
  return pts;
}

/** A point well inside a polygon: the centroid when it is inside, otherwise the grid point furthest from the edges. */
export function labelPoint(poly: Vec2[]): Vec2 {
  const c = polygonCentroid(poly);
  const edgeDist = (p: Vec2) => Math.min(...poly.map((a, i) => closestOnSegment(p, a, poly[(i + 1) % poly.length]).d));
  if (pointInPolygon(c, poly) && edgeDist(c) > 0.3) return c;
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let best: Vec2 = c, bestD = -1;
  for (let i = 1; i < 24; i++)
    for (let j = 1; j < 24; j++) {
      const p: Vec2 = [x0 + ((x1 - x0) * i) / 24, y0 + ((y1 - y0) * j) / 24];
      if (!pointInPolygon(p, poly)) continue;
      const d = edgeDist(p);
      if (d > bestD) { bestD = d; best = p; }
    }
  return best;
}

/** Bounding box of a level's nodes. */
export function levelBounds(level: Level): { min: Vec2; max: Vec2; center: Vec2; size: Vec2 } {
  if (!level.nodes.length) return { min: [0, 0], max: [0, 0], center: [0, 0], size: [0, 0] };
  const xs = level.nodes.map((n) => n.x), ys = level.nodes.map((n) => n.y);
  const min: Vec2 = [Math.min(...xs), Math.min(...ys)], max: Vec2 = [Math.max(...xs), Math.max(...ys)];
  return { min, max, center: scale(add(min, max), 0.5), size: sub(max, min) };
}


// ---------------------------------------------------------------- wall pieces

export interface WallPieces {
  /** Full-height stretches of the wall outline between openings (joints included at the ends). */
  solids: Vec2[][];
  /** The wall outline across each opening. */
  gaps: { span: ReturnType<typeof openingSpans>[number]; polygon: Vec2[] }[];
}

/** Cuts a wall outline at its openings. Used by the 3D builder and the 2D editor alike. */
export function wallPieces(idx: LevelIndex, fp: WallFootprint): WallPieces {
  const g = fp.geom;
  const toU = (p: Vec2) => (p[0] - g.a[0]) * g.dir[0] + (p[1] - g.a[1]) * g.dir[1];
  const slab = (u0: number, u1: number) => clipPolygon(clipPolygon(fp.polygon, (p) => toU(p) - u0), (p) => u1 - toU(p));
  const spans = openingSpans(idx, g.wall.id).filter((s) => s.u1 - s.u0 > 0.01);
  const solids: Vec2[][] = [];
  let cursor = -Infinity;
  const ranges: [number, number][] = [];
  for (const s of spans) { ranges.push([cursor, s.u0]); cursor = Math.max(cursor, s.u1); }
  ranges.push([cursor, Infinity]);
  for (const [u0, u1] of ranges) {
    if (u1 - u0 < 1e-4) continue;
    const poly = slab(u0, u1);
    if (poly.length >= 3 && Math.abs(polygonArea(poly)) > 1e-6) solids.push(poly);
  }
  const gaps = spans.map((span) => ({ span, polygon: slab(span.u0, span.u1) })).filter((x) => x.polygon.length >= 3);
  return { solids, gaps };
}
