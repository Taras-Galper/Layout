// Checks a plan for errors (it cannot be built) and warnings (it builds, but something looks off).
import {
  type Level, type Plan, OPENING_KINDS, PLAN_SCHEMA, ROOM_TYPES, WALL_KINDS,
  openingHead, openingSill, wallHeight,
} from './plan';
import { dist, segmentsCross } from './geometry';

export interface Issue {
  level?: string;
  id?: string;
  /** Translation key; params fill its placeholders. */
  key: string;
  params?: Record<string, string | number>;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

export function validatePlan(input: unknown): ValidationResult {
  const errors: Issue[] = [], warnings: Issue[] = [];
  const res = (): ValidationResult => ({ ok: errors.length === 0, errors, warnings });
  const p = input as Plan;
  if (!p || typeof p !== 'object') { errors.push({ key: 'issue.notPlan' }); return res(); }
  if (p.schema !== PLAN_SCHEMA) errors.push({ key: 'issue.notPlan' });
  if (p.version !== 1) errors.push({ key: 'issue.version', params: { v: String(p.version) } });
  if (!Array.isArray(p.levels) || p.levels.length === 0) { errors.push({ key: 'issue.noLevels' }); return res(); }
  const levelIds = new Set<string>();
  for (const level of p.levels) {
    if (levelIds.has(level.id)) errors.push({ level: level.id, key: 'issue.duplicateId', params: { id: level.id } });
    levelIds.add(level.id);
    validateLevel(level, errors, warnings);
  }
  return res();
}

function validateLevel(level: Level, errors: Issue[], warnings: Issue[]) {
  const L = level.id;
  for (const k of ['nodes', 'walls', 'openings', 'rooms'] as const)
    if (!Array.isArray(level[k])) { errors.push({ level: L, key: 'issue.missingList', params: { list: k } }); return; }
  if (!(level.height > 0)) errors.push({ level: L, key: 'issue.badNumber', params: { field: 'height' } });

  const ids = new Set<string>();
  const unique = (id: string) => {
    if (!id) errors.push({ level: L, key: 'issue.missingId' });
    else if (ids.has(id)) errors.push({ level: L, id, key: 'issue.duplicateId', params: { id } });
    ids.add(id);
  };

  const nodes = new Map<string, [number, number]>();
  for (const n of level.nodes) {
    unique(n.id);
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) errors.push({ level: L, id: n.id, key: 'issue.badNumber', params: { field: n.id } });
    nodes.set(n.id, [n.x, n.y]);
  }
  const nodeList = [...nodes.entries()];
  for (let i = 0; i < nodeList.length; i++)
    for (let j = i + 1; j < nodeList.length; j++)
      if (dist(nodeList[i][1], nodeList[j][1]) < 0.01)
        warnings.push({ level: L, id: nodeList[i][0], key: 'issue.nodesOverlap', params: { a: nodeList[i][0], b: nodeList[j][0] } });

  const walls = new Map<string, { a: [number, number]; b: [number, number]; len: number; h: number; na: string; nb: string }>();
  const pairs = new Set<string>();
  for (const w of level.walls) {
    unique(w.id);
    const a = nodes.get(w.a), b = nodes.get(w.b);
    if (!a || !b) { errors.push({ level: L, id: w.id, key: 'issue.unknownNode', params: { id: w.id } }); continue; }
    if (!WALL_KINDS.includes(w.kind)) errors.push({ level: L, id: w.id, key: 'issue.badKind', params: { id: w.id, kind: String(w.kind) } });
    if (!(w.thickness > 0)) errors.push({ level: L, id: w.id, key: 'issue.badNumber', params: { field: `${w.id}.thickness` } });
    const len = dist(a, b);
    if (len < 0.01) { errors.push({ level: L, id: w.id, key: 'issue.zeroWall', params: { id: w.id } }); continue; }
    const pair = [w.a, w.b].sort().join('|');
    if (pairs.has(pair)) errors.push({ level: L, id: w.id, key: 'issue.duplicateWall', params: { id: w.id } });
    pairs.add(pair);
    walls.set(w.id, { a, b, len, h: wallHeight(w, level), na: w.a, nb: w.b });
  }
  const wl = [...walls.entries()];
  for (let i = 0; i < wl.length; i++)
    for (let j = i + 1; j < wl.length; j++) {
      const [ia, A] = wl[i], [ib, B] = wl[j];
      if (A.na === B.na || A.na === B.nb || A.nb === B.na || A.nb === B.nb) continue;
      if (segmentsCross(A.a, A.b, B.a, B.b)) warnings.push({ level: L, id: ia, key: 'issue.wallsCross', params: { a: ia, b: ib } });
    }

  const byWall = new Map<string, { id: string; u0: number; u1: number }[]>();
  for (const o of level.openings) {
    unique(o.id);
    const w = walls.get(o.wall);
    if (!w) { errors.push({ level: L, id: o.id, key: 'issue.unknownWall', params: { id: o.id } }); continue; }
    if (!OPENING_KINDS.includes(o.kind)) errors.push({ level: L, id: o.id, key: 'issue.badKind', params: { id: o.id, kind: String(o.kind) } });
    if (!(o.width > 0)) errors.push({ level: L, id: o.id, key: 'issue.badNumber', params: { field: `${o.id}.width` } });
    const u0 = o.offset - o.width / 2, u1 = o.offset + o.width / 2;
    if (u0 < -1e-6 || u1 > w.len + 1e-6) warnings.push({ level: L, id: o.id, key: 'issue.openingOutside', params: { id: o.id } });
    if (openingSill(o) >= openingHead(o, w.h)) warnings.push({ level: L, id: o.id, key: 'issue.openingHeight', params: { id: o.id } });
    const list = byWall.get(o.wall) ?? [];
    for (const other of list)
      if (u0 < other.u1 - 1e-6 && other.u0 < u1 - 1e-6)
        warnings.push({ level: L, id: o.id, key: 'issue.openingsOverlap', params: { a: other.id, b: o.id } });
    list.push({ id: o.id, u0, u1 });
    byWall.set(o.wall, list);
  }

  for (const r of level.rooms) {
    unique(r.id);
    if (!ROOM_TYPES.includes(r.type)) errors.push({ level: L, id: r.id, key: 'issue.badKind', params: { id: r.id, kind: String(r.type) } });
    if (!Array.isArray(r.at) || r.at.length !== 2) errors.push({ level: L, id: r.id, key: 'issue.badNumber', params: { field: `${r.id}.at` } });
  }
}
