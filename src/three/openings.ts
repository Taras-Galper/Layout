// Parametric door, window and slider models, built in the wall's local frame:
// x along the wall (a → b), y up, z across the wall. Plan-left of the wall is local -z.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Opening } from '../model/plan';
import { MATERIALS } from './materials';

export interface OpeningSpec {
  opening: Opening;
  width: number;
  sill: number;
  head: number;
  thickness: number;
}

export interface OpeningModel {
  group: THREE.Group;
  /** Pivot of a swinging leaf, for opening and closing later. */
  leaf?: THREE.Object3D;
}

/** Collects boxes per material and merges them into one mesh per material. */
class Boxes {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  add(mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number) {
    if (sx <= 0 || sy <= 0 || sz <= 0) return;
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    const list = this.parts.get(mat) ?? [];
    list.push(g);
    this.parts.set(mat, list);
  }
  into(group: THREE.Object3D) {
    for (const [mat, list] of this.parts) {
      const mesh = new THREE.Mesh(mergeGeometries(list), mat);
      const isGlass = mat === MATERIALS.glass;
      mesh.castShadow = !isGlass;
      mesh.receiveShadow = !isGlass;
      group.add(mesh);
      list.forEach((g) => g.dispose());
    }
  }
}

const FRAME = 0.05;

export function buildOpening(s: OpeningSpec): OpeningModel {
  switch (s.opening.kind) {
    case 'door': case 'entry': return door(s);
    case 'window': return windowModel(s);
    case 'slider': return slider(s);
    case 'passage': return passage(s);
  }
}

function door(s: OpeningSpec): OpeningModel {
  const { width: w, head: h, thickness: t } = s;
  const group = new THREE.Group();
  const b = new Boxes();
  const depth = t + 0.02;
  // jambs and head
  b.add(MATERIALS.frame, FRAME, h, depth, -w / 2 + FRAME / 2, h / 2, 0);
  b.add(MATERIALS.frame, FRAME, h, depth, w / 2 - FRAME / 2, h / 2, 0);
  b.add(MATERIALS.frame, w, FRAME, depth, 0, h - FRAME / 2, 0);
  b.into(group);

  // leaf, hinged on one jamb and opened towards its swing side
  const o = s.opening;
  const hingeAtStart = (o.hinge ?? 'start') === 'start';
  const swingLeft = (o.swing ?? 'left') === 'left';
  const leafW = w - 2 * FRAME, leafH = h - FRAME - 0.01, leafT = 0.04;
  const side = swingLeft ? -1 : 1; // plan-left is local -z
  const pivot = new THREE.Group();
  pivot.position.set(hingeAtStart ? -w / 2 + FRAME : w / 2 - FRAME, 0, side * (t / 2 - leafT / 2));
  const leafGeo = new THREE.BoxGeometry(leafW, leafH, leafT);
  leafGeo.translate(hingeAtStart ? leafW / 2 : -leafW / 2, leafH / 2 + 0.005, 0);
  const leaf = new THREE.Mesh(leafGeo, o.kind === 'entry' ? MATERIALS.entryLeaf : MATERIALS.doorLeaf);
  leaf.castShadow = leaf.receiveShadow = true;
  pivot.add(leaf);
  // rotating +x by φ about y gives (cos φ, 0, -sin φ): towards -z for φ > 0
  const open = THREE.MathUtils.degToRad(o.kind === 'entry' ? 70 : 85);
  pivot.rotation.y = (hingeAtStart ? 1 : -1) * (swingLeft ? 1 : -1) * open;
  pivot.userData.openAngle = pivot.rotation.y;
  group.add(pivot);
  return { group, leaf: pivot };
}

function windowModel(s: OpeningSpec): OpeningModel {
  const { width: w, sill, head, thickness: t } = s;
  const h = head - sill;
  const group = new THREE.Group();
  const b = new Boxes();
  const d = 0.07;
  const yMid = sill + h / 2;
  // outer frame
  b.add(MATERIALS.frameDark, FRAME, h, d, -w / 2 + FRAME / 2, yMid, 0);
  b.add(MATERIALS.frameDark, FRAME, h, d, w / 2 - FRAME / 2, yMid, 0);
  b.add(MATERIALS.frameDark, w, FRAME, d, 0, head - FRAME / 2, 0);
  b.add(MATERIALS.frameDark, w, FRAME, d, 0, sill + FRAME / 2, 0);
  // mullion on wide windows
  const panes = w > 1.3 ? 2 : 1;
  if (panes === 2) b.add(MATERIALS.frameDark, FRAME, h, d, 0, yMid, 0);
  // glass
  b.add(MATERIALS.glass, w - 2 * FRAME, h - 2 * FRAME, 0.01, 0, yMid, 0);
  // stone sill through the wall
  if (sill > 0.05) b.add(MATERIALS.stoneSill, w + 0.04, 0.03, t + 0.05, 0, sill - 0.015, 0);
  b.into(group);
  return { group };
}

function slider(s: OpeningSpec): OpeningModel {
  const { width: w, sill, head } = s;
  const h = head - sill;
  const group = new THREE.Group();
  const b = new Boxes();
  const d = 0.12;
  // outer frame
  b.add(MATERIALS.frameDark, FRAME, h, d, -w / 2 + FRAME / 2, sill + h / 2, 0);
  b.add(MATERIALS.frameDark, FRAME, h, d, w / 2 - FRAME / 2, sill + h / 2, 0);
  b.add(MATERIALS.frameDark, w, FRAME, d, 0, head - FRAME / 2, 0);
  b.add(MATERIALS.frameDark, w, 0.02, d, 0, sill + 0.01, 0);
  // two sashes on separate tracks, the second slid partly open
  const inner = w - 2 * FRAME, sashW = inner / 2 + 0.03, sashH = h - FRAME - 0.02;
  const sash = (cx: number, z: number) => {
    const y0 = sill + 0.02, ym = y0 + sashH / 2;
    b.add(MATERIALS.frameDark, 0.04, sashH, 0.04, cx - sashW / 2 + 0.02, ym, z);
    b.add(MATERIALS.frameDark, 0.04, sashH, 0.04, cx + sashW / 2 - 0.02, ym, z);
    b.add(MATERIALS.frameDark, sashW, 0.05, 0.04, cx, y0 + sashH - 0.025, z);
    b.add(MATERIALS.frameDark, sashW, 0.06, 0.04, cx, y0 + 0.03, z);
    b.add(MATERIALS.glass, sashW - 0.08, sashH - 0.11, 0.008, cx, ym + 0.005, z);
  };
  sash(-inner / 4, 0.025);
  sash(inner / 4 - inner * 0.18, -0.025);
  b.into(group);
  return { group };
}

function passage(s: OpeningSpec): OpeningModel {
  // a slim casing so the opening reads as finished
  const { width: w, head: h, thickness: t } = s;
  const group = new THREE.Group();
  const b = new Boxes();
  const c = 0.015, depth = t + 0.01;
  b.add(MATERIALS.frame, c, h, depth, -w / 2 + c / 2, h / 2, 0);
  b.add(MATERIALS.frame, c, h, depth, w / 2 - c / 2, h / 2, 0);
  b.add(MATERIALS.frame, w, c, depth, 0, h - c / 2, 0);
  b.into(group);
  return { group };
}
