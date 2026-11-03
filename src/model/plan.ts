// Plan model, version 1. See docs/plan-model.md and schema/plan.schema.json.
// Units: metres. Plan coordinates: x right, y up the sheet. In 3D: (x, elevation, -y).

export type Vec2 = [number, number];

export const PLAN_SCHEMA = 'walkabout.plan';
export const PLAN_VERSION = 1;

export interface Plan {
  schema: typeof PLAN_SCHEMA;
  version: typeof PLAN_VERSION;
  units: 'm';
  name: string;
  /** Angle of true north, clockwise from plan +y, degrees. */
  north?: number;
  source?: PlanSource;
  levels: Level[];
  meta?: Record<string, unknown>;
}

export interface PlanSource {
  file?: string;
  page?: number;
  kind?: 'dxf' | 'dwg' | 'pdf-vector' | 'pdf-raster' | 'image' | 'drawn';
  metresPerUnit?: number;
  /** Affine drawing-to-plan transform [a, b, c, d, e, f]. */
  transform?: [number, number, number, number, number, number];
  [key: string]: unknown;
}

export interface Level {
  id: string;
  name: string;
  /** Finished floor height above building zero. */
  elevation: number;
  /** Default floor-to-ceiling wall height on this level. */
  height: number;
  slabThickness?: number;
  nodes: PlanNode[];
  walls: Wall[];
  openings: Opening[];
  rooms: RoomTag[];
}

export interface PlanNode {
  id: string;
  x: number;
  y: number;
}

export const WALL_KINDS = ['exterior', 'interior', 'partition', 'structural', 'railing', 'virtual'] as const;
export type WallKind = (typeof WALL_KINDS)[number];

export interface Wall {
  id: string;
  a: string;
  b: string;
  thickness: number;
  kind: WallKind;
  height?: number;
  /**
   * Curved wall: how far the middle of the wall bows out from the straight line a → b, in metres,
   * positive to the left of a → b. Missing or 0 for a straight wall.
   */
  sagitta?: number;
  confidence?: number;
}

export const OPENING_KINDS = ['door', 'entry', 'window', 'slider', 'passage'] as const;
export type OpeningKind = (typeof OPENING_KINDS)[number];

export interface Opening {
  id: string;
  wall: string;
  /** Distance from wall node `a` along the wall to the opening centre. */
  offset: number;
  width: number;
  kind: OpeningKind;
  sill?: number;
  head?: number;
  hinge?: 'start' | 'end';
  swing?: 'left' | 'right';
  confidence?: number;
}

export const ROOM_TYPES = [
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'wc', 'laundry', 'storage', 'closet',
  'hallway', 'entry', 'office', 'safe_room', 'balcony', 'other',
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export interface RoomTag {
  id: string;
  type: RoomType;
  name?: string;
  at: Vec2;
  floor?: string;
  confidence?: number;
}

// ---------------------------------------------------------------- defaults

export const OPENING_DEFAULTS: Record<OpeningKind, { sill: number; head: number }> = {
  door: { sill: 0, head: 2.1 },
  entry: { sill: 0, head: 2.1 },
  window: { sill: 0.9, head: 2.2 },
  slider: { sill: 0, head: 2.4 },
  passage: { sill: 0, head: 2.1 },
};

export const RAILING_HEIGHT = 1.05;
export const DEFAULT_SLAB = 0.2;

export function wallHeight(wall: Wall, level: Level): number {
  if (wall.height !== undefined) return wall.height;
  if (wall.kind === 'railing') return RAILING_HEIGHT;
  if (wall.kind === 'virtual') return 0;
  return level.height;
}

export function openingSill(o: Opening): number {
  return o.sill ?? OPENING_DEFAULTS[o.kind].sill;
}

export function openingHead(o: Opening, wallH: number): number {
  return Math.min(o.head ?? OPENING_DEFAULTS[o.kind].head, wallH);
}

/** Openings you can walk through (no sill). */
export function isWalkable(o: Opening): boolean {
  return openingSill(o) < 0.05;
}

export function emptyPlan(name = 'Untitled'): Plan {
  return {
    schema: PLAN_SCHEMA,
    version: PLAN_VERSION,
    units: 'm',
    name,
    levels: [{ id: 'L0', name: 'Ground', elevation: 0, height: 2.7, nodes: [], walls: [], openings: [], rooms: [] }],
  };
}
