// Shared materials for the shell. Plain colours for now; the material library (tileable PBR
// textures) comes with the furniture milestone and replaces these by key.
import * as THREE from 'three';
import type { RoomType } from '../model/plan';

const std = (color: number, roughness: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...extra });

export const MATERIALS = {
  wall: std(0xeeeae4, 0.92),
  wallExterior: std(0xe6e1d8, 0.95),
  /** Top of a cut wall, darker so the cut reads clearly from above. */
  wallCap: std(0x4b4a48, 0.9),
  railing: std(0xdedbd5, 0.85),
  ceiling: std(0xf4f2ee, 0.95),
  slab: std(0xbdb8ae, 0.95),
  ground: std(0xa9ab9e, 1),
  frame: std(0xf3f1ec, 0.55),
  frameDark: std(0x33363a, 0.45, { metalness: 0.4 }),
  doorLeaf: std(0xe9e4da, 0.5),
  entryLeaf: std(0x5a4636, 0.55),
  stoneSill: std(0xd6d1c7, 0.6),
  glass: new THREE.MeshPhysicalMaterial({
    color: 0xdfe9ec, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.18,
    depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.5,
  }),
  floor: {
    wood: std(0xb08560, 0.62),
    tile: std(0xd8d4cc, 0.38),
    tileSmall: std(0xcfd2d0, 0.42),
    deck: std(0x8b6b4e, 0.8),
  },
};

export function floorMaterial(type: RoomType): THREE.Material {
  switch (type) {
    case 'bathroom': case 'wc': case 'laundry': return MATERIALS.floor.tileSmall;
    case 'kitchen': case 'entry': return MATERIALS.floor.tile;
    case 'balcony': return MATERIALS.floor.deck;
    default: return MATERIALS.floor.wood;
  }
}

export function hasCeiling(type: RoomType): boolean {
  return type !== 'balcony';
}
