import { describe, expect, it } from 'vitest';
import { emptyPlan, type Level } from '../src/model/plan';
import {
  addOpening, addRect, addRoomTag, addWall, deleteWall, moveNode, settleNode, splitWall, pushWall,
} from '../src/model/edit';
import { detectRooms, indexLevel } from '../src/model/topology';
import { validatePlan } from '../src/model/validate';

const ext = { thickness: 0.25, kind: 'exterior' as const };
const int = { thickness: 0.12, kind: 'interior' as const };
const TOL = 0.05;

function fresh(): Level {
  return emptyPlan().levels[0];
}
function valid(level: Level) {
  const p = emptyPlan();
  p.levels[0] = level;
  return validatePlan(p);
}
const rooms = (l: Level) => detectRooms(indexLevel(l)).rooms;

describe('drawing walls', () => {
  it('a rectangle makes one closed room', () => {
    const l = fresh();
    addRect(l, [0, 0], [5, 4], ext, TOL);
    expect(l.walls.length).toBe(4);
    expect(l.nodes.length).toBe(4);
    expect(rooms(l).length).toBe(1);
    expect(valid(l).errors).toEqual([]);
  });

  it('a wall across a room splits it in two and splits the walls it meets', () => {
    const l = fresh();
    addRect(l, [0, 0], [6, 4], ext, TOL);
    addWall(l, [3, 0], [3, 4], int, TOL);
    expect(l.walls.length).toBe(7); // two outer walls split, plus the new one
    expect(rooms(l).length).toBe(2);
    const r = valid(l);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('a wall drawn through other walls is split at every crossing', () => {
    const l = fresh();
    addRect(l, [0, 0], [6, 4], ext, TOL);
    addWall(l, [-1, 2], [7, 2], int, TOL);
    expect(valid(l).warnings.filter((w) => w.key === 'issue.wallsCross')).toEqual([]);
    expect(rooms(l).length).toBe(2);
  });

  it('end points snap to nearby nodes', () => {
    const l = fresh();
    addWall(l, [0, 0], [4, 0], ext, TOL);
    addWall(l, [4.02, 0.01], [4, 3], ext, TOL);
    expect(l.nodes.length).toBe(3);
  });

  it('two rectangles sharing a side form two rooms', () => {
    const l = fresh();
    addRect(l, [0, 0], [4, 4], ext, TOL);
    addRect(l, [4, 0], [7, 4], ext, TOL);
    expect(rooms(l).length).toBe(2);
    expect(valid(l).errors).toEqual([]);
  });
});

describe('openings follow edits', () => {
  it('splitting a wall moves openings to the right half', () => {
    const l = fresh();
    const [w] = addWall(l, [0, 0], [6, 0], ext, TOL);
    const near = addOpening(l, w, 1, 'window');
    const far = addOpening(l, w, 5, 'door');
    splitWall(l, w, 3);
    const o1 = l.openings.find((o) => o.id === near)!, o2 = l.openings.find((o) => o.id === far)!;
    expect(o1.wall).toBe(w);
    expect(o2.wall).not.toBe(w);
    expect(o2.offset).toBeCloseTo(2, 6);
  });

  it('deleting a crossing wall heals the split and keeps openings in place', () => {
    const l = fresh();
    addRect(l, [0, 0], [6, 4], ext, TOL);
    const bottom = l.walls.find((w) => {
      const a = l.nodes.find((n) => n.id === w.a)!, b = l.nodes.find((n) => n.id === w.b)!;
      return a.y === 0 && b.y === 0;
    })!;
    addOpening(l, bottom.id, 5, 'window');
    const [mid] = addWall(l, [3, 0], [3, 4], int, TOL);
    expect(l.walls.length).toBe(7);
    deleteWall(l, mid);
    expect(l.walls.length).toBe(4);
    const o = l.openings[0];
    expect(o.wall).toBe(bottom.id);
    expect(o.offset).toBeCloseTo(5, 3);
  });

  it('openings stay inside a wall that gets shorter', () => {
    const l = fresh();
    const [w] = addWall(l, [0, 0], [4, 0], ext, TOL);
    addOpening(l, w, 3.5, 'window', { width: 1.2 });
    const b = l.walls[0].b;
    moveNode(l, b, [2, 0]);
    const o = l.openings[0];
    expect(o.offset + o.width / 2).toBeLessThanOrEqual(2);
  });
});

describe('moving things', () => {
  it('dragging a node onto another joins them', () => {
    const l = fresh();
    addWall(l, [0, 0], [4, 0], ext, TOL);
    addWall(l, [0, 3], [4, 3.2], ext, TOL);
    const loose = l.nodes.find((n) => n.x === 4 && n.y === 3.2)!.id;
    moveNode(l, loose, [4.01, 0.02]);
    settleNode(l, loose, TOL);
    expect(l.nodes.length).toBe(3);
  });

  it('pushing a wall keeps the room closed', () => {
    const l = fresh();
    addRect(l, [0, 0], [4, 4], ext, TOL);
    const id = l.walls[1].id; // the right-hand side
    pushWall(l, id, -1); // left of a→b (going up) is -x… push outward by 1
    const r = rooms(l);
    expect(r.length).toBe(1);
    expect(r[0].polygon.length).toBe(4);
  });

  it('room tags attach to the loop they are in', () => {
    const l = fresh();
    addRect(l, [0, 0], [6, 4], ext, TOL);
    addWall(l, [3, 0], [3, 4], int, TOL);
    addRoomTag(l, [1, 1], 'bedroom');
    addRoomTag(l, [5, 1], 'kitchen');
    const { rooms: rs, untagged, orphanTags } = detectRooms(indexLevel(l));
    expect(untagged).toBe(0);
    expect(orphanTags).toEqual([]);
    expect(rs.map((r) => r.type).sort()).toEqual(['bedroom', 'kitchen']);
  });
});
