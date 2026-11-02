import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Plan } from '../src/model/plan';
import { validatePlan } from '../src/model/validate';
import { detectRooms, indexLevel, wallFootprints } from '../src/model/topology';
import { polygonArea } from '../src/model/geometry';

const load = (f: string) => JSON.parse(readFileSync(new URL(`../public/plans/${f}`, import.meta.url), 'utf8')) as Plan;

describe('sample flat', () => {
  const plan = load('sample-flat.json');
  const idx = indexLevel(plan.levels[0]);

  it('validates cleanly', () => {
    const r = validatePlan(plan);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('finds every room and matches the tags', () => {
    const { rooms, untagged, orphanTags } = detectRooms(idx);
    expect(rooms.length).toBe(9);
    expect(untagged).toBe(0);
    expect(orphanTags).toEqual([]);
    const byId = Object.fromEntries(rooms.map((r) => [r.id, r]));
    // centre-line areas: main bedroom is an L (5×5 minus the 1.5×1.8 WC)
    expect(polygonArea(byId.main.polygon)).toBeCloseTo(25 - 1.5 * 1.8, 6);
    expect(polygonArea(byId.living.polygon)).toBeCloseTo(7 * 5, 6);
    // inside-wall area is smaller than the centre-line area
    for (const r of rooms) expect(r.area).toBeLessThan(polygonArea(r.polygon));
    expect(byId.bed1.area).toBeGreaterThan(3.5 * 2.8 * 0.8);
  });

  it('builds a closed, positive outline for every wall', () => {
    const fp = wallFootprints(idx);
    expect(fp.size).toBe(plan.levels[0].walls.length);
    for (const [id, f] of fp) {
      const a = polygonArea(f.polygon);
      expect(a, id).toBeGreaterThan(0);
      // area close to length × thickness (joints add or remove a little)
      expect(a, id).toBeLessThan(f.geom.length * f.geom.wall.thickness * 1.6 + 0.1);
      for (const p of f.polygon) expect(Number.isFinite(p[0]) && Number.isFinite(p[1]), id).toBe(true);
    }
  });
});

describe('studio', () => {
  const plan = load('studio.json');
  it('validates and handles the angled wall', () => {
    expect(validatePlan(plan).errors).toEqual([]);
    const { rooms, untagged } = detectRooms(indexLevel(plan.levels[0]));
    expect(rooms.length).toBe(2);
    expect(untagged).toBe(0);
  });
});

describe('validation', () => {
  it('rejects garbage and catches broken references', () => {
    expect(validatePlan(null).ok).toBe(false);
    const plan = load('studio.json');
    plan.levels[0].walls[0].b = 'nope';
    plan.levels[0].openings[0].wall = 'missing';
    const r = validatePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.key)).toEqual(expect.arrayContaining(['issue.unknownNode', 'issue.unknownWall']));
  });
});
