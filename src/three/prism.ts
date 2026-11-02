// Builds flat-shaded prisms (a plan polygon extruded between two heights) into one BufferGeometry.
// Plan (x, y) maps to 3D (x, height, -y).
import * as THREE from 'three';
import type { Vec2 } from '../model/plan';
import { polygonArea } from '../model/geometry';

type V3 = [number, number, number];

export class PrismBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  /** Triangles per material group, in insertion order. */
  private groups: { start: number; count: number; mat: number }[] = [];

  /**
   * @param poly plan polygon (any winding)
   * @param capMat material index for the top face (sides and bottom use 0)
   */
  addPrism(poly: Vec2[], y0: number, y1: number, opts: { capMat?: number; top?: boolean; bottom?: boolean } = {}) {
    if (poly.length < 3 || y1 - y0 < 1e-5) return;
    const ccw = polygonArea(poly) > 0 ? poly : [...poly].reverse();
    if (Math.abs(polygonArea(ccw)) < 1e-7) return;
    const n = ccw.length;
    for (let i = 0; i < n; i++) {
      const p = ccw[i], q = ccw[(i + 1) % n];
      const ex = q[0] - p[0], ey = q[1] - p[1];
      const l = Math.hypot(ex, ey);
      if (l < 1e-7) continue;
      // outward normal of a CCW polygon edge is to its right: (ey, -ex) in plan → (ey, 0, ex) in 3D
      const nrm: V3 = [ey / l, 0, ex / l];
      const tx = ex / l, ty = ey / l;
      const u = (a: Vec2) => a[0] * tx + a[1] * ty;
      this.quad(
        [p[0], y0, -p[1]], [q[0], y0, -q[1]], [q[0], y1, -q[1]], [p[0], y1, -p[1]], nrm,
        [[u(p), y0], [u(q), y0], [u(q), y1], [u(p), y1]], 0,
      );
    }
    const contour = ccw.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    if (opts.top !== false)
      for (const [a, b, c] of tris) this.tri(ccw[a], ccw[b], ccw[c], y1, [0, 1, 0], opts.capMat ?? 0);
    if (opts.bottom !== false)
      for (const [a, b, c] of tris) this.tri(ccw[a], ccw[b], ccw[c], y0, [0, -1, 0], 0);
  }

  private tri(a: Vec2, b: Vec2, c: Vec2, y: number, nrm: V3, mat: number) {
    this.face([[a[0], y, -a[1]], [b[0], y, -b[1]], [c[0], y, -c[1]]], nrm, [[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]], mat);
  }

  private quad(a: V3, b: V3, c: V3, d: V3, nrm: V3, uv: Vec2[], mat: number) {
    this.face([a, b, c], nrm, [uv[0], uv[1], uv[2]], mat);
    this.face([a, c, d], nrm, [uv[0], uv[2], uv[3]], mat);
  }

  /** Adds a triangle, flipping it if needed so it faces along nrm. */
  private face(v: V3[], nrm: V3, uv: Vec2[], mat: number) {
    const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
    const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
    if (Math.hypot(cx, cy, cz) < 1e-10) return;
    const order = cx * nrm[0] + cy * nrm[1] + cz * nrm[2] < 0 ? [0, 2, 1] : [0, 1, 2];
    const last = this.groups[this.groups.length - 1];
    if (last && last.mat === mat) last.count += 3;
    else this.groups.push({ start: this.pos.length / 3, count: 3, mat });
    for (const i of order) {
      this.pos.push(...v[i]);
      this.nor.push(...nrm);
      this.uv.push(...uv[i]);
    }
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const gr of this.groups) g.addGroup(gr.start, gr.count, gr.mat);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** A flat polygon at height y facing up (+1) or down (-1). */
export function flatPolygon(poly: Vec2[], y: number, facing: 1 | -1): THREE.BufferGeometry {
  const ccw = polygonArea(poly) > 0 ? poly : [...poly].reverse();
  const shape = new THREE.Shape(ccw.map((p) => new THREE.Vector2(p[0], p[1])));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2); // (x, y, 0) → (x, 0, -y), normal +z → +y
  if (facing === -1) {
    // flip winding and normals so the face looks down
    const idx = g.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
    const n = g.getAttribute('normal');
    for (let i = 0; i < n.count; i++) n.setY(i, -n.getY(i));
  }
  g.translate(0, y, 0);
  return g;
}
