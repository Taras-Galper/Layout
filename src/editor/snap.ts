// Snapping for drawing: existing points, straight angles from the previous point, lining up with
// other points, and walls. Tolerances are given in plan metres (the editor converts from pixels).
import type { Level, Vec2 } from '../model/plan';
import { add, dist, dot, lineIntersect, norm, scale, sub } from '../model/geometry';
import { findNode, findWall, wallEnds } from '../model/edit';

export interface SnapResult {
  p: Vec2;
  /** What it snapped to, for the marker. */
  kind: 'node' | 'wall' | 'angle' | 'align' | 'free';
  /** Alignment guides to draw: lines through these points, horizontal or vertical. */
  guides: { from: Vec2; to: Vec2 }[];
  nodeId?: string;
  wallId?: string;
}

export interface SnapOptions {
  tol: number;
  /** The previous point of the wall being drawn: enables angle snapping. */
  from?: Vec2;
  /** Nodes to ignore (the one being dragged). */
  except?: Set<string>;
  /** Snapping off (Alt held): only rounding. */
  off?: boolean;
  /** Rounding step for free points. */
  grid?: number;
}

const ANGLE_STEP = Math.PI / 4; // 0°, 45°, 90°…
const ANGLE_TOL = (6 * Math.PI) / 180;

export function snapPoint(level: Level, raw: Vec2, o: SnapOptions): SnapResult {
  const grid = o.grid ?? 0.01;
  const roundP = (p: Vec2): Vec2 => [Math.round(p[0] / grid) * grid, Math.round(p[1] / grid) * grid];
  if (o.off) return { p: roundP(raw), kind: 'free', guides: [] };

  const node = findNode(level, raw, o.tol, o.except);
  if (node) return { p: [node.x, node.y], kind: 'node', guides: [], nodeId: node.id };

  let p: Vec2 = raw;
  let kind: SnapResult['kind'] = 'free';
  let ray: { o: Vec2; d: Vec2 } | undefined;

  // straight angles from the previous point
  if (o.from && dist(o.from, raw) > o.tol) {
    const v = sub(raw, o.from);
    const ang = Math.atan2(v[1], v[0]);
    const snapped = Math.round(ang / ANGLE_STEP) * ANGLE_STEP;
    if (Math.abs(ang - snapped) < ANGLE_TOL) {
      const d: Vec2 = [Math.cos(snapped), Math.sin(snapped)];
      p = add(o.from, scale(d, dot(v, d)));
      ray = { o: o.from, d };
      kind = 'angle';
    }
  }

  // line up with other points
  const guides: SnapResult['guides'] = [];
  const horizontal = ray && Math.abs(ray.d[1]) < 1e-6, vertical = ray && Math.abs(ray.d[0]) < 1e-6;
  let ax: Vec2 | undefined, ay: Vec2 | undefined;
  for (const n of level.nodes) {
    if (o.except?.has(n.id)) continue;
    if (!vertical && Math.abs(n.x - p[0]) < o.tol && (!ax || Math.abs(n.x - p[0]) < Math.abs(ax[0] - p[0]))) ax = [n.x, n.y];
    if (!horizontal && Math.abs(n.y - p[1]) < o.tol && (!ay || Math.abs(n.y - p[1]) < Math.abs(ay[1] - p[1]))) ay = [n.x, n.y];
  }
  if (ray && !horizontal && !vertical) { ax = undefined; ay = undefined; }
  if (ax) { p = [ax[0], p[1]]; guides.push({ from: ax, to: p }); }
  if (ay) { p = [p[0], ay[1]]; guides.push({ from: ay, to: p }); }
  if (ax || ay) kind = 'align';

  // walls: the cursor is on one → land on it (along the snapped angle when there is one)
  const hit = findWall(level, p, o.tol, undefined);
  if (hit && !(ax && ay)) {
    const e = wallEnds(level, hit.wall);
    let q = hit.point;
    if (ray) {
      const x = lineIntersect(ray.o, ray.d, e.a, e.dir);
      if (x && dist(x, p) < o.tol * 2) q = x;
    } else if (ax || ay) {
      const d: Vec2 = ax ? [0, 1] : [1, 0];
      const x = lineIntersect(p, d, e.a, e.dir);
      if (x && dist(x, p) < o.tol * 2) q = x;
    }
    if (dist(q, p) < o.tol * 2) return { p: q, kind: 'wall', guides, wallId: hit.wall.id };
  }

  if (kind === 'free') p = roundP(p);
  return { p, kind, guides };
}

/** Direction helper for typed lengths: the unit vector from `from` towards the snapped point. */
export function directionTo(from: Vec2, to: Vec2): Vec2 {
  return norm(sub(to, from));
}
