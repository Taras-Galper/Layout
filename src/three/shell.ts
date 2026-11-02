// Turns a plan into the 3D shell: walls with joints and openings, door / window models, floors,
// ceilings and slabs. Also returns what the views need: per-wall objects for the cutaway,
// floors for picking, collision outlines for walking, and room labels.
import * as THREE from 'three';
import type { Level, Plan, RoomTag, Vec2 } from '../model/plan';
import { DEFAULT_SLAB } from '../model/plan';
import { clipPolygon, polygonArea } from '../model/geometry';
import {
  type Room, type WallGeom, detectRooms, fromWallLocal, indexLevel, openingSpans, wallFootprints,
} from '../model/topology';
import { MATERIALS, floorMaterial, hasCeiling } from './materials';
import { flatPolygon, PrismBuilder } from './prism';
import { buildOpening } from './openings';

export interface WallObject {
  group: THREE.Group;
  geom: WallGeom;
  height: number;
  /** Wall centre in 3D. */
  center: THREE.Vector3;
  /** Current and target vertical scale, animated by the cutaway. */
  scale: number;
  target: number;
}

export interface LevelBuild {
  level: Level;
  group: THREE.Group;
  walls: WallObject[];
  floors: THREE.Mesh[];
  ceilings: THREE.Mesh[];
  rooms: Room[];
  /** Plan outlines you cannot walk through. */
  blockers: Vec2[][];
  untagged: number;
  /** Room tags that are not inside any closed loop. */
  orphanTags: RoomTag[];
}

export interface ShellBuild {
  group: THREE.Group;
  levels: LevelBuild[];
  /** Bounding box of everything built. */
  box: THREE.Box3;
}

export function buildShell(plan: Plan): ShellBuild {
  const group = new THREE.Group();
  group.name = 'shell';
  const levels = plan.levels.map((level) => buildLevel(level));
  for (const l of levels) group.add(l.group);
  const box = new THREE.Box3().setFromObject(group);
  return { group, levels, box };
}

function buildLevel(level: Level): LevelBuild {
  const idx = indexLevel(level);
  const footprints = wallFootprints(idx);
  const { rooms, outlines, untagged, orphanTags } = detectRooms(idx);
  const group = new THREE.Group();
  group.name = `level:${level.id}`;
  group.position.y = level.elevation;
  const walls: WallObject[] = [];
  const blockers: Vec2[][] = [];

  for (const [id, fp] of footprints) {
    const g = fp.geom;
    const H = g.height;
    const isExterior = g.wall.kind === 'exterior';
    const wallGroup = new THREE.Group();
    wallGroup.name = `wall:${id}`;
    const pb = new PrismBuilder();
    const toU = (p: Vec2) => (p[0] - g.a[0]) * g.dir[0] + (p[1] - g.a[1]) * g.dir[1];
    const slab = (u0: number, u1: number) =>
      clipPolygon(clipPolygon(fp.polygon, (p) => toU(p) - u0), (p) => u1 - toU(p));

    const spans = openingSpans(idx, id).filter((s) => s.u1 - s.u0 > 0.01);
    // solid stretches between openings (the first and last include the joints)
    let cursor = -Infinity;
    const solids: [number, number][] = [];
    for (const s of spans) { solids.push([cursor, s.u0]); cursor = s.u1; }
    solids.push([cursor, Infinity]);
    for (const [u0, u1] of solids) {
      const poly = slab(u0, u1);
      if (poly.length >= 3 && Math.abs(polygonArea(poly)) > 1e-6) {
        pb.addPrism(poly, 0, H, { capMat: 1 });
        blockers.push(poly);
      }
    }
    for (const s of spans) {
      const poly = slab(s.u0, s.u1);
      if (poly.length < 3) continue;
      if (s.sill > 0.005) pb.addPrism(poly, 0, s.sill);
      if (s.head < H - 0.005) pb.addPrism(poly, s.head, H, { capMat: 1 });
      if (s.sill > 0.05) blockers.push(poly); // windows block walking
      // the door / window model, placed at the opening centre and turned along the wall
      const model = buildOpening({ opening: s.opening, width: s.u1 - s.u0, sill: s.sill, head: s.head, thickness: g.wall.thickness });
      const c = fromWallLocal(g, (s.u0 + s.u1) / 2, 0);
      model.group.position.set(c[0], 0, -c[1]);
      model.group.rotation.y = Math.atan2(g.dir[1], g.dir[0]);
      model.group.name = `opening:${s.opening.id}`;
      wallGroup.add(model.group);
    }

    if (!pb.empty) {
      const side = g.wall.kind === 'railing' ? MATERIALS.railing : isExterior ? MATERIALS.wallExterior : MATERIALS.wall;
      const mesh = new THREE.Mesh(pb.build(), [side, MATERIALS.wallCap]);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = `wallmesh:${id}`;
      wallGroup.add(mesh);
    }
    const mid = fromWallLocal(g, g.length / 2, 0);
    walls.push({ group: wallGroup, geom: g, height: H, center: new THREE.Vector3(mid[0], H / 2, -mid[1]), scale: 1, target: 1 });
    group.add(wallGroup);
  }

  // floors and ceilings follow the room loops (centre-lines; walls cover the overlap)
  const floors: THREE.Mesh[] = [], ceilings: THREE.Mesh[] = [];
  for (const r of rooms) {
    const floor = new THREE.Mesh(flatPolygon(r.polygon, 0.002, 1), floorMaterial(r.type));
    floor.receiveShadow = true;
    floor.name = `floor:${r.id}`;
    floor.userData.roomId = r.id;
    floors.push(floor);
    group.add(floor);
    if (hasCeiling(r.type)) {
      const ceil = new THREE.Mesh(flatPolygon(r.polygon, level.height, -1), MATERIALS.ceiling);
      ceil.name = `ceiling:${r.id}`;
      ceil.castShadow = true;
      ceil.receiveShadow = true;
      ceilings.push(ceil);
      group.add(ceil);
    }
  }

  // floor slab under each building outline
  const slabT = level.slabThickness ?? DEFAULT_SLAB;
  if (slabT > 0) {
    const pb = new PrismBuilder();
    for (const o of outlines) pb.addPrism(o, -slabT, 0, { top: false });
    if (!pb.empty) {
      const slabMesh = new THREE.Mesh(pb.build(), MATERIALS.slab);
      slabMesh.receiveShadow = true;
      slabMesh.castShadow = true;
      slabMesh.name = 'slab';
      group.add(slabMesh);
    }
  }

  return { level, group, walls, floors, ceilings, rooms, blockers, untagged, orphanTags };
}

export function disposeShell(shell: ShellBuild): void {
  shell.group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
  shell.group.removeFromParent();
}
