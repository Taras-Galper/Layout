import { describe, expect, it } from 'vitest';
import { emptyPlan, type Level } from '../src/model/plan';
import { arcFromSagitta, arcParam, arcPoint, sagittaThrough, subSagitta } from '../src/model/arc';
import { addCircle, addRect, addWall, deleteWall, splitWall, addOpening } from '../src/model/edit';
import { detectRooms, indexLevel, wallFootprints, wallPieces } from '../src/model/topology';
import { validatePlan } from '../src/model/validate';
import { dist, polygonArea } from '../src/model/geometry';

const ext = { thickness: 0.2, kind: 'exterior' as const };
const TOL = 0.05;
const fresh = (): Level => emptyPlan().levels[0];
const check = (l: Level) => {
  const p = emptyPlan();
  p.levels[0] = l;
  return validatePlan(p);
};

describe('arc maths', () => {
  it('a half circle', () => {
    const arc = arcFromSagitta([0, 0], [4, 0], 2)!;
    expect(arc.radius).toBeCloseTo(2, 9);
    expect(arc.center[0]).toBeCloseTo(2, 9);
    expect(arc.center[1]).toBeCloseTo(0, 9);
    expect(arc.length).toBeCloseTo(Math.PI * 2, 9);
    const mid = arcPoint(arc, arc.length / 2);
    expect(mid[0]).toBeCloseTo(2, 9);
    expect(mid[1]).toBeCloseTo(2, 9); // positive sagitta bows to the left of a → b
    expect(arcParam(arc, [2, 2.5])).toBeCloseTo(arc.length / 2, 9);
  });

  it('three points give back the sagitta, small and large arcs alike', () => {
    for (const s of [0.3, 1.5, -0.8, 3.2, -4]) {
      const arc = arcFromSagitta([1, 1], [5, 2], s)!;
      const p = arcPoint(arc, arc.length * 0.3);
      expect(sagittaThrough([1, 1], [5, 2], p)).toBeCloseTo(s, 6);
    }
  });

  it('the parts of a split arc stay on the circle', () => {
    const arc = arcFromSagitta([0, 0], [6, 0], 1.2)!;
    const u = arc.length * 0.4;
    const p = arcPoint(arc, u);
    const first = arcFromSagitta([0, 0], p, subSagitta(arc, 0, u))!;
    const second = arcFromSagitta(p, [6, 0], subSagitta(arc, u, arc.length))!;
    for (const a of [first, second]) {
      expect(a.radius).toBeCloseTo(arc.radius, 6);
      expect(dist(a.center, arc.center)).toBeLessThan(1e-6);
    }
    expect(first.length + second.length).toBeCloseTo(arc.length, 6);
  });
});

describe('curved walls in a plan', () => {
  it('a room with one curved side has the area of a box plus a segment', () => {
    const l = fresh();
    addRect(l, [0, 0], [4, 3], ext, TOL);
    // bow the right-hand wall outwards by 1 m
    const right = l.walls.find((w) => {
      const a = l.nodes.find((n) => n.id === w.a)!, b = l.nodes.find((n) => n.id === w.b)!;
      return a.x === 4 && b.x === 4;
    })!;
    const a = l.nodes.find((n) => n.id === right.a)!;
    right.sagitta = a.y === 0 ? -1 : 1; // going up the left is −x; outwards is +x
    const { rooms } = detectRooms(indexLevel(l));
    expect(rooms.length).toBe(1);
    const arc = arcFromSagitta([4, 0], [4, 3], -1)!;
    const segment = (arc.radius ** 2 / 2) * (Math.abs(arc.sweep) - Math.sin(Math.abs(arc.sweep)));
    expect(polygonArea(rooms[0].polygon)).toBeCloseTo(12 + segment, 1);
    expect(check(l).errors).toEqual([]);
  });

  it('a round room is closed, has the right area and validates', () => {
    const l = fresh();
    addCircle(l, [0, 0], 3, ext, TOL);
    expect(l.walls.length).toBe(2);
    const r = check(l);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const { rooms } = detectRooms(indexLevel(l));
    expect(rooms.length).toBe(1);
    expect(polygonArea(rooms[0].polygon)).toBeCloseTo(Math.PI * 9, 0);
    expect(rooms[0].area).toBeCloseTo(Math.PI * 2.9 ** 2, 0); // inside the 20 cm wall
  });

  it('a straight wall across a round room splits it in two', () => {
    const l = fresh();
    addCircle(l, [0, 0], 3, ext, TOL);
    addWall(l, [0, -4], [0, 4], { thickness: 0.1, kind: 'interior' }, TOL);
    const r = check(l);
    expect(r.errors).toEqual([]);
    expect(r.warnings.filter((w) => w.key === 'issue.wallsCross')).toEqual([]);
    const { rooms } = detectRooms(indexLevel(l));
    expect(rooms.length).toBe(2);
    for (const room of rooms) expect(polygonArea(room.polygon)).toBeCloseTo((Math.PI * 9) / 2, 0);
  });

  it('splitting a curved wall keeps its shape, openings included', () => {
    const l = fresh();
    const [w] = addWall(l, [0, 0], [6, 0], { ...ext, sagitta: 1.5 }, TOL);
    const before = indexLevel(l).walls.get(w)!;
    const win = addOpening(l, w, before.length * 0.75, 'window');
    splitWall(l, w, before.length / 2);
    const idx = indexLevel(l);
    const total = [...idx.walls.values()].reduce((s, g) => s + g.length, 0);
    expect(total).toBeCloseTo(before.length, 3); // positions are kept to the millimetre
    const o = l.openings.find((x) => x.id === win)!;
    expect(o.wall).not.toBe(w);
    expect(o.offset).toBeCloseTo(before.length * 0.25, 3);
  });

  it('wall outlines and cut pieces of a curved wall are sound', () => {
    const l = fresh();
    const [w] = addWall(l, [0, 0], [5, 0], { ...ext, sagitta: 1 }, TOL);
    const g = indexLevel(l).walls.get(w)!;
    addOpening(l, w, g.length / 2, 'window', { width: 1.2 });
    const idx = indexLevel(l);
    const fp = wallFootprints(idx).get(w)!;
    expect(polygonArea(fp.polygon)).toBeCloseTo(g.length * 0.2, 1);
    const pieces = wallPieces(idx, fp);
    expect(pieces.solids.length).toBe(2);
    expect(pieces.gaps.length).toBe(1);
    expect(Math.abs(polygonArea(pieces.gaps[0].polygon))).toBeCloseTo(1.2 * 0.2, 1);
  });

  it('deleting one half of a round room leaves an arc', () => {
    const l = fresh();
    const ids = addCircle(l, [0, 0], 2, ext, TOL);
    deleteWall(l, ids[0]);
    expect(l.walls.length).toBe(1);
    expect(Math.abs(l.walls[0].sagitta!)).toBeCloseTo(2, 6);
    expect(l.nodes.length).toBe(2);
  });
});
