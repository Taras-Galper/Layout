// Small 2D geometry helpers used by the model and the 3D builder.
import type { Vec2 } from './plan';

export const EPS = 1e-9;

export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < EPS ? [0, 0] : [a[0] / l, a[1] / l];
};
/** Perpendicular pointing left of the direction. */
export const perpLeft = (a: Vec2): Vec2 => [-a[1], a[0]];

/** Signed area; positive for counter-clockwise polygons. */
export function polygonArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < EPS) {
    const s = poly.reduce((acc, p) => add(acc, p), [0, 0] as Vec2);
    return scale(s, 1 / poly.length);
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Intersection of two infinite lines p + t·d and q + s·e, or null when (nearly) parallel. */
export function lineIntersect(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-6) return null;
  const t = cross(sub(q, p), e) / den;
  return add(p, scale(d, t));
}

/** Proper intersection of segments ab and cd (touching at end points does not count). */
export function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2, tol = 1e-6): boolean {
  const r = sub(b, a), s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < EPS) return false;
  const t = cross(sub(c, a), s) / den, u = cross(sub(c, a), r) / den;
  return t > tol && t < 1 - tol && u > tol && u < 1 - tol;
}

/** Keep the part of a polygon where f(p) >= 0, for a linear f (Sutherland–Hodgman, one plane). */
export function clipPolygon(poly: Vec2[], f: (p: Vec2) => number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const fp = f(p), fq = f(q);
    if (fp >= 0) out.push(p);
    if ((fp >= 0) !== (fq >= 0)) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Distance from point p to segment ab, and the closest point. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; d: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < EPS ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  const point = add(a, scale(ab, t));
  return { point, d: dist(p, point) };
}

/** Remove consecutive duplicates and collinear points. */
export function simplifyPolygon(poly: Vec2[], tol = 1e-6): Vec2[] {
  let pts = poly.filter((p, i) => dist(p, poly[(i + 1) % poly.length]) > tol);
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      if (Math.abs(cross(sub(b, a), sub(c, b))) < tol) {
        pts = pts.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return pts;
}
