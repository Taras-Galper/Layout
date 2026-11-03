// The properties of the selected element (or of the plan when nothing is selected).
import type { Store } from '../app/store';
import { formatNumber, t } from '../i18n';
import { OPENING_DEFAULTS, OPENING_KINDS, ROOM_TYPES, WALL_KINDS, type Level, wallHeight } from '../model/plan';
import { dist, norm, sub, add, scale, pointInPolygon } from '../model/geometry';
import {
  WALL_PRESETS, addRoomTag, clampOpening, geomOf, nodeById, openingById, roomById, settleNode, wallById, wallEnds, moveNode,
} from '../model/edit';
import { detectRooms, indexLevel } from '../model/topology';

type Field =
  | { kind: 'number'; label: string; value: number | undefined; unit: 'cm' | 'm' | '°'; placeholder?: number; set: (v: number | undefined, l: Level) => void; min?: number }
  | { kind: 'select'; label: string; value: string; options: { value: string; label: string }[]; set: (v: string, l: Level) => void }
  | { kind: 'text'; label: string; value: string; placeholder?: string; set: (v: string, l: Level) => void }
  | { kind: 'info'; label: string; value: string }
  | { kind: 'buttons'; buttons: { label: string; run: (l: Level) => void; danger?: boolean }[] };

const toUnit = (v: number, unit: 'cm' | 'm' | '°'): number => (unit === 'cm' ? Math.round(v * 1000) / 10 : unit === 'm' ? Math.round(v * 1000) / 1000 : v);
const fromUnit = (v: number, unit: 'cm' | 'm' | '°') => (unit === 'cm' ? v / 100 : v);

export class PropertiesPanel {
  constructor(private readonly host: HTMLElement, private readonly title: HTMLElement, private readonly store: Store, private readonly onDelete: () => void) {
    store.on((e) => { if (e !== 'live') this.render(); });
    this.render();
  }

  render(): void {
    const { title, fields } = this.describe();
    this.title.textContent = title;
    this.host.replaceChildren(...fields.map((f) => this.field(f)));
  }

  private edit(fn: (l: Level) => void): void {
    this.store.edit((l) => fn(l));
  }

  private describe(): { title: string; fields: Field[] } {
    const s = this.store.selection;
    const level = this.store.level;
    const del = { label: t('props.delete'), run: () => this.onDelete(), danger: true };
    if (!s) {
      const plan = this.store.plan;
      return {
        title: t('props.plan'),
        fields: [
          { kind: 'text', label: t('props.name'), value: plan.name, set: (v) => { this.store.plan.name = v || plan.name; } },
          { kind: 'number', label: t('props.ceiling'), value: level.height, unit: 'm', min: 1.8, set: (v, l) => { if (v) l.height = v; } },
          { kind: 'number', label: t('props.north'), value: plan.north ?? 0, unit: '°', set: (v) => { this.store.plan.north = v ?? 0; } },
          { kind: 'info', label: t('props.counts'), value: t('props.countsValue', { walls: level.walls.length, openings: level.openings.length, rooms: level.rooms.length }) },
        ],
      };
    }
    if (s.kind === 'wall') {
      const w = wallById(level, s.id);
      if (!w) return { title: '', fields: [] };
      const e = wallEnds(level, w);
      const geom = geomOf(level, w);
      return {
        title: w.sagitta ? t('props.curvedWall') : t('props.wall'),
        fields: [
          {
            kind: 'select', label: t('props.type'), value: w.kind,
            options: WALL_KINDS.map((k) => ({ value: k, label: t(`wall.${k}`) })),
            set: (v, l) => {
              const x = wallById(l, s.id)!;
              const fromPreset = Math.abs(x.thickness - WALL_PRESETS[x.kind]) < 1e-6;
              x.kind = v as typeof x.kind;
              if (fromPreset) x.thickness = WALL_PRESETS[x.kind];
            },
          },
          { kind: 'number', label: t('props.thickness'), value: w.thickness, unit: 'cm', min: 0.01, set: (v, l) => { if (v) wallById(l, s.id)!.thickness = v; } },
          {
            kind: 'number', label: t('props.length'), value: e.len, unit: 'm', min: 0.05,
            set: (v, l) => {
              if (!v) return;
              const x = wallById(l, s.id)!;
              const ends = wallEnds(l, x);
              // a curved wall keeps its shape: the straight distance scales with the length
              const k = v / ends.len;
              const chord = Math.hypot(ends.b[0] - ends.a[0], ends.b[1] - ends.a[1]);
              moveNode(l, x.b, add(ends.a, scale(ends.dir, chord * k)));
              if (x.sagitta) x.sagitta *= k;
              settleNode(l, x.b, 0.01);
            },
          },
          { kind: 'number', label: t('props.height'), value: w.height, placeholder: wallHeight({ ...w, height: undefined }, level), unit: 'm', set: (v, l) => { const x = wallById(l, s.id)!; if (v) x.height = v; else delete x.height; } },
          {
            kind: 'number', label: t('props.curve'), value: w.sagitta ?? 0, unit: 'cm',
            set: (v, l) => { const x = wallById(l, s.id)!; if (v && Math.abs(v) >= 0.005) x.sagitta = v; else delete x.sagitta; },
          },
          ...(geom?.arc ? [{ kind: 'info' as const, label: t('props.radius'), value: `${formatNumber(geom.arc.radius, 2)} m` }] : []),
          {
            kind: 'buttons',
            buttons: [
              ...(w.sagitta ? [
                { label: t('props.straighten'), run: (l: Level) => { delete wallById(l, s.id)!.sagitta; } },
                { label: t('props.flipCurve'), run: (l: Level) => { const x = wallById(l, s.id)!; if (x.sagitta) x.sagitta = -x.sagitta; } },
              ] : []),
              del,
            ],
          },
        ],
      };
    }
    if (s.kind === 'opening') {
      const o = openingById(level, s.id);
      if (!o) return { title: '', fields: [] };
      const isDoor = o.kind === 'door' || o.kind === 'entry';
      const defaults = OPENING_DEFAULTS[o.kind];
      const fields: Field[] = [
        {
          kind: 'select', label: t('props.type'), value: o.kind,
          options: OPENING_KINDS.map((k) => ({ value: k, label: t(`opening.${k}`) })),
          set: (v, l) => {
            const x = openingById(l, s.id)!;
            x.kind = v as typeof x.kind;
            if (x.kind === 'door' || x.kind === 'entry') { x.hinge ??= 'start'; x.swing ??= 'left'; }
            else { delete x.hinge; delete x.swing; }
          },
        },
        { kind: 'number', label: t('props.width'), value: o.width, unit: 'cm', min: 0.2, set: (v, l) => { const x = openingById(l, s.id)!; if (v) { x.width = v; clampOpening(l, x); } } },
        { kind: 'number', label: t('props.sill'), value: o.sill, placeholder: defaults.sill, unit: 'cm', set: (v, l) => { const x = openingById(l, s.id)!; if (v === undefined) delete x.sill; else x.sill = v; } },
        { kind: 'number', label: t('props.head'), value: o.head, placeholder: defaults.head, unit: 'cm', set: (v, l) => { const x = openingById(l, s.id)!; if (v === undefined) delete x.head; else x.head = v; } },
      ];
      const buttons: { label: string; run: (l: Level) => void; danger?: boolean }[] = [];
      if (isDoor) {
        buttons.push(
          { label: t('props.flipHinge'), run: (l) => { const x = openingById(l, s.id)!; x.hinge = x.hinge === 'end' ? 'start' : 'end'; } },
          { label: t('props.flipSwing'), run: (l) => { const x = openingById(l, s.id)!; x.swing = x.swing === 'right' ? 'left' : 'right'; } },
        );
      }
      buttons.push(del);
      fields.push({ kind: 'buttons', buttons });
      return { title: t(`opening.${o.kind}`), fields };
    }
    if (s.kind === 'node') {
      const n = nodeById(level, s.id);
      if (!n) return { title: '', fields: [] };
      return {
        title: t('props.point'),
        fields: [
          { kind: 'number', label: 'X', value: n.x, unit: 'm', set: (v, l) => { if (v !== undefined) { moveNode(l, s.id, [v, nodeById(l, s.id)!.y]); settleNode(l, s.id, 0.01); } } },
          { kind: 'number', label: 'Y', value: n.y, unit: 'm', set: (v, l) => { if (v !== undefined) { moveNode(l, s.id, [nodeById(l, s.id)!.x, v]); settleNode(l, s.id, 0.01); } } },
          { kind: 'buttons', buttons: [del] },
        ],
      };
    }
    // a room: tagged, or a closed loop without a name yet
    const rooms = detectRooms(indexLevel(level)).rooms;
    const tag = s.kind === 'room' ? roomById(level, s.id) : undefined;
    const room = s.kind === 'room' ? rooms.find((r) => r.tag?.id === s.id) : rooms.find((r) => !r.tag && pointInPolygon(s.at, r.polygon));
    const typeOptions = ROOM_TYPES.map((k) => ({ value: k, label: t(`room.${k}`) }));
    if (!tag) {
      const at = s.kind === 'loop' ? s.at : [0, 0];
      return {
        title: t('room.unnamed'),
        fields: [
          {
            kind: 'select', label: t('props.type'), value: '', options: [{ value: '', label: t('props.chooseType') }, ...typeOptions],
            set: (v, l) => { if (v) { const id = addRoomTag(l, room?.labelAt ?? (at as [number, number]), v as typeof ROOM_TYPES[number]); queueMicrotask(() => this.store.select({ kind: 'room', id })); } },
          },
          ...(room ? [{ kind: 'info' as const, label: t('props.area'), value: t('unit.area', { v: formatNumber(room.area) }) }] : []),
        ],
      };
    }
    const tagId = tag.id;
    return {
      title: t('props.room'),
      fields: [
        { kind: 'select', label: t('props.type'), value: tag.type, options: typeOptions, set: (v, l) => { roomById(l, tagId)!.type = v as typeof tag.type; } },
        { kind: 'text', label: t('props.name'), value: tag.name ?? '', placeholder: t(`room.${tag.type}`), set: (v, l) => { const r = roomById(l, tagId)!; if (v.trim()) r.name = v.trim(); else delete r.name; } },
        { kind: 'info', label: t('props.area'), value: room ? t('unit.area', { v: formatNumber(room.area) }) : t('props.notClosed') },
        ...(room ? [{ kind: 'info' as const, label: t('props.size'), value: sizeText(room.inner) }] : []),
        { kind: 'buttons', buttons: [del] },
      ],
    };
  }

  private field(f: Field): HTMLElement {
    const row = document.createElement('div');
    row.className = 'prop';
    if (f.kind === 'buttons') {
      row.classList.add('prop--buttons');
      for (const b of f.buttons) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = b.danger ? 'btn btn--danger' : 'btn';
        btn.textContent = b.label;
        btn.addEventListener('click', () => (b.danger ? b.run(this.store.level) : this.edit(b.run)));
        row.append(btn);
      }
      return row;
    }
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.className = 'prop__label';
    name.textContent = f.label;
    label.append(name);
    row.append(label);
    if (f.kind === 'info') {
      const v = document.createElement('span');
      v.className = 'prop__info';
      v.textContent = f.value;
      label.append(v);
      return row;
    }
    if (f.kind === 'select') {
      const sel = document.createElement('select');
      for (const o of f.options) sel.add(new Option(o.label, o.value));
      sel.value = f.value;
      sel.addEventListener('change', () => this.edit((l) => f.set(sel.value, l)));
      label.append(sel);
      return row;
    }
    const input = document.createElement('input');
    input.type = f.kind === 'number' ? 'number' : 'text';
    if (f.kind === 'number') {
      input.step = f.unit === 'cm' ? '1' : f.unit === 'm' ? '0.01' : '1';
      if (f.value !== undefined) input.value = String(toUnit(f.value, f.unit));
      if (f.placeholder !== undefined) input.placeholder = String(toUnit(f.placeholder, f.unit));
      const unit = document.createElement('span');
      unit.className = 'prop__unit';
      unit.textContent = f.unit === '°' ? '°' : t(`unit.${f.unit}`);
      const wrap = document.createElement('span');
      wrap.className = 'prop__num';
      wrap.append(input, unit);
      label.append(wrap);
      input.addEventListener('change', () => {
        const raw = input.value.trim();
        const v = raw === '' ? undefined : Number(raw.replace(',', '.'));
        if (v !== undefined && (!Number.isFinite(v) || (f.min !== undefined && fromUnit(v, f.unit) < f.min))) { this.render(); return; }
        this.edit((l) => f.set(v === undefined ? undefined : fromUnit(v, f.unit), l));
      });
    } else {
      input.value = f.value;
      if (f.placeholder) input.placeholder = f.placeholder;
      input.addEventListener('change', () => this.edit((l) => f.set(input.value, l)));
      label.append(input);
    }
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
    return row;
  }
}

/** Width × depth of a room's bounding box along its longest edge, in metres. */
function sizeText(poly: [number, number][]): string {
  if (poly.length < 3) return '';
  let best = 0, dir: [number, number] = [1, 0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const d = dist(a, b);
    if (d > best) { best = d; dir = norm(sub(b, a)); }
  }
  const n: [number, number] = [-dir[1], dir[0]];
  const us = poly.map((p) => p[0] * dir[0] + p[1] * dir[1]), vs = poly.map((p) => p[0] * n[0] + p[1] * n[1]);
  const w = Math.max(...us) - Math.min(...us), h = Math.max(...vs) - Math.min(...vs);
  return `${formatNumber(Math.max(w, h), 2)} × ${formatNumber(Math.min(w, h), 2)} m`;
}
