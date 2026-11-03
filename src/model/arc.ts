// Circular arcs for curved walls. A curved wall keeps its two end nodes and adds a sagitta:
// how far the middle of the wall bows away from the straight line between its ends, in metres,
// positive to the left of a → b. (A DXF bulge b converts as sagitta = b · chord / 2.)
import type { Vec2 } from './plan';
import { add, cross, dist, norm, perpLeft, scale, sub } from './geometry';

export interface Arc {
  center: Vec2;
  radius: number;
  /** Angle of the start point seen from the centre. */
  start: number;
  /** Signed sweep a → b in radians: positive is counter-clockwise. */
  sweep: number;
  /** Length along the arc. */
  length: number;
  sagitta: number;
}

/** Below this a wall is treated as straight. */
export const MIN_SAGITTA = 0.005;

export function arcFromSagitta(a: Vec2, b: Vec2, sagitta: number): Arc | null {
  const c = dist(a, b);
  if (Math.abs(sagitta) < MIN_SAGITTA || c < 1e-6) return null;
  const s = sagitta;
  const n = perpLeft(norm(sub(b, a)));
  const mid = scale(add(a, b), 0.5);
  const apex = add(mid, scale(n, s));
  const radius = (c * c / 4 + s * s) / (2 * Math.abs(s));
  const center = sub(apex, scale(n, Math.sign(s) * radius));
  const theta = 4 * Math.atan((2 * Math.abs(s)) / c);
  // bowing to the left of a → b means turning clockwise around the centre
  const sweep = s > 0 ? -theta : theta;
  const start = Math.atan2(a[1] - center[1], a[0] - center[0]);
  return { center, radius, start, sweep, length: radius * theta, sagitta: s };
}

/** Sagitta of the arc through a, b and a third point p (the side of p decides the bow). */
export function sagittaThrough(a: Vec2, b: Vec2, p: Vec2): number {
  const ab = sub(b, a);
  const c = Math.hypot(ab[0], ab[1]);
  const side = cross(ab, sub(p, a));
  if (c < 1e-6 || Math.abs(side) / c < 1e-4) return 0;
  // circumcentre of a, b, p
  const d = 2 * (a[0] * (b[1] - p[1]) + b[0] * (p[1] - a[1]) + p[0] * (a[1] - b[1]));
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, p2 = p[0] ** 2 + p[1] ** 2;
  const center: Vec2 = [(a2 * (b[1] - p[1]) + b2 * (p[1] - a[1]) + p2 * (a[1] - b[1])) / d, (a2 * (p[0] - b[0]) + b2 * (a[0] - p[0]) + p2 * (b[0] - a[0])) / d];
  const r = dist(center, a);
  const h = Math.sqrt(Math.max(0, r * r - (c * c) / 4)); // centre to chord
  const centerSide = cross(ab, sub(center, a));
  const sameSide = Math.sign(centerSide) === Math.sign(side) && Math.abs(centerSide) > 1e-9;
  const mag = sameSide ? r + h : r - h; // past a half circle when the centre is on p's side
  return Math.sign(side) * mag;
}

export function arcPoint(arc: Arc, u: number): Vec2 {
  const ang = arc.start + arc.sweep * (u / arc.length);
  return [arc.center[0] + arc.radius * Math.cos(ang), arc.center[1] + arc.radius * Math.sin(ang)];
}

/** Unit tangent in the a → b direction at distance u. */
export function arcTangent(arc: Arc, u: number): Vec2 {
  const ang = arc.start + arc.sweep * (u / arc.length);
  const s = Math.sign(arc.sweep);
  return [-Math.sin(ang) * s, Math.cos(ang) * s];
}

/** Distance along the arc of the point nearest to p, not clamped (negative before a, past the length after b). */
export function arcParam(arc: Arc, p: Vec2): number {
  const mid = arc.start + arc.sweep / 2;
  let d = Math.atan2(p[1] - arc.center[1], p[0] - arc.center[0]) - mid;
  d = Math.atan2(Math.sin(d), Math.cos(d)); // wrap to (−π, π]
  return arc.length * (0.5 + d / arc.sweep);
}

/** Number of straight pieces used to draw an arc: about one every 5°. */
export function arcSegments(arc: Arc): number {
  return Math.min(96, Math.max(4, Math.ceil(Math.abs(arc.sweep) / ((5 * Math.PI) / 180))));
}

/** Sagitta of the part of an arc between distances u0 and u1. */
export function subSagitta(arc: Arc, u0: number, u1: number): number {
  const sweep = (arc.sweep * (u1 - u0)) / arc.length;
  return -Math.sign(arc.sweep) * arc.radius * (1 - Math.cos(sweep / 2));
}
