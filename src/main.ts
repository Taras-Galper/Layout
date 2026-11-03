import './style.css';
import * as THREE from 'three';
import { formatNumber, setLanguage, t, translateDom } from './i18n';
import { type Plan, ROOM_TYPES, WALL_KINDS, emptyPlan } from './model/plan';
import { type Issue, validatePlan } from './model/validate';
import { WALL_PRESETS } from './model/edit';
import { Store } from './app/store';
import { Viewer, type Quality } from './three/viewer';
import { Views, type ViewMode } from './three/views';
import { buildShell, disposeShell, type ShellBuild } from './three/shell';
import { floorMaterial } from './three/materials';
import { RoomLabels, roomName } from './ui/labels';
import { Editor2D, type Tool } from './editor/editor2d';
import { PropertiesPanel } from './editor/properties';
import { defaultTransform, pdfPageCount, readUnderlayFile, restoreUnderlay, saveUnderlay } from './editor/underlay';
import { Ask } from './editor/ask';

setLanguage('en');
translateDom();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- state and views

const store = new Store(Store.restore() ?? emptyPlan(t('plan.untitled')));
const workspace = $('workspace');
const viewer = new Viewer($('stage'));
const views = new Views(viewer);
const labels = new RoomLabels($('labels'), (room) => {
  if (room.tag) store.select({ kind: 'room', id: room.tag.id });
  views.focusOn(room.labelAt, Math.sqrt(room.area));
});
const editor = new Editor2D($('plan2d'), store);
const ask = new Ask($('plan2d'));
new PropertiesPanel($('props'), $('props-title'), store, () => editor.deleteSelection());

/** Saved as a file (or loaded) at this revision; anything newer is unsaved work. */
let savedRevision = store.revision;
let shell: ShellBuild | undefined;

// ---------------------------------------------------------------- 3D, kept in step with the plan

let rebuildTimer = 0;
let builtRevision = -1;
function rebuild(keepCamera: boolean): void {
  window.clearTimeout(rebuildTimer);
  rebuildTimer = 0;
  if (builtRevision === store.revision && shell) return;
  builtRevision = store.revision;
  const result = validatePlan(store.plan);
  if (!result.ok) {
    renderIssues(result.errors, result.warnings);
    return;
  }
  const old = shell;
  const wasEmpty = !old || old.levels.every((l) => l.walls.length === 0);
  shell = buildShell(store.plan);
  // the first walls of a new plan: frame them, the camera was looking at an empty scene
  if (wasEmpty && shell.levels.some((l) => l.walls.length > 0)) keepCamera = false;
  if (shell.box.isEmpty()) shell.box.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 2.7, 5));
  viewer.scene.add(shell.group);
  if (old) disposeShell(old);
  if (!keepCamera) viewer.setFocus(shell.box);
  else viewer.setFocus(shell.box.clone().union(new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 0, 1))));
  views.setShell(shell, store.levelIndex, keepCamera);
  applyTime();
  renderRooms();
  const extra: Issue[] = [];
  for (const l of shell.levels) {
    if (l.untagged) extra.push({ level: l.level.id, key: 'panel.untagged', params: { n: l.untagged } });
    for (const tag of l.orphanTags) extra.push({ level: l.level.id, id: tag.id, key: 'issue.orphanTag', params: { name: tag.name ?? t(`room.${tag.type}`) } });
  }
  renderIssues(result.errors, [...result.warnings, ...extra]);
}

store.on((e) => {
  if (e === 'selection') { renderRooms(); return; }
  if (e === 'live') {
    // while dragging, rebuild a few times a second rather than on every move
    if (!rebuildTimer) rebuildTimer = window.setTimeout(() => rebuild(true), 120);
  } else rebuild(e !== 'load');
  updateUndo();
  renderPlanSelect();
});

// ---------------------------------------------------------------- loading plans and drawings

async function loadSampleList(): Promise<{ file: string; name: string }[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}plans/index.json`);
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

let samples: { file: string; name: string }[] = [];

function hasUnsavedWork(): boolean {
  return store.revision !== savedRevision && store.level.walls.length > 0;
}

function confirmReplace(): boolean {
  return !hasUnsavedWork() || window.confirm(t('confirm.replace'));
}

function openPlan(input: unknown, keepUnderlay = false): boolean {
  const result = validatePlan(input);
  if (!result.ok) {
    renderIssues(result.errors, result.warnings);
    toast(t('load.invalid'));
    return false;
  }
  if (!keepUnderlay) { editor.setUnderlay(null); saveUnderlay(null); }
  store.load(input as Plan);
  savedRevision = store.revision;
  toast();
  return true;
}

async function loadSample(file: string): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}plans/${file}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    openPlan(await res.json());
  } catch (e) {
    toast(t('load.failed', { reason: (e as Error).message }));
  }
}

async function openFile(file: File): Promise<void> {
  const isJson = /\.json$/i.test(file.name) || file.type === 'application/json';
  if (isJson) {
    if (!confirmReplace()) return;
    try {
      openPlan(JSON.parse(await file.text()));
    } catch (e) {
      toast(t('load.failed', { reason: (e as Error).message }));
    }
    return;
  }
  // an image or a PDF: trace it. Into the current plan when it is empty, else a new plan.
  const empty = store.level.walls.length === 0;
  if (!empty && !confirmReplace()) return;
  await addUnderlay(file, !empty);
}

async function addUnderlay(file: File, freshPlan: boolean): Promise<void> {
  toast(t('load.opening', { name: file.name }), 'info');
  try {
    let page = 1;
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      const n = await pdfPageCount(file);
      if (n > 1) {
        const host = $('plan2d');
        const v = await ask.ask(t('ask.page'), { x: host.clientWidth / 2 - 100, y: host.clientHeight / 3 }, '1', t('ask.pageHint', { n }));
        if (v === null) return;
        page = Math.min(n, Math.max(1, Math.round(Number(v)) || 1));
      }
    }
    const u = await readUnderlayFile(file, page);
    const name = file.name.replace(/\.[^.]+$/, '');
    if (freshPlan || store.level.walls.length === 0) {
      const plan = emptyPlan(name);
      plan.source = { file: file.name, kind: u.kind === 'pdf' ? 'pdf-raster' : 'image', page: u.page, transform: defaultTransform(u.width) };
      editor.setUnderlay(u);
      store.load(plan);
      savedRevision = store.revision;
    } else {
      editor.setUnderlay(u);
      store.edit((_, plan) => { plan.source = { file: file.name, kind: u.kind === 'pdf' ? 'pdf-raster' : 'image', page: u.page, transform: defaultTransform(u.width) }; });
      editor.fit();
    }
    saveUnderlay(u);
    refreshUnderlayControls();
    setLayout(window.innerWidth < 900 ? 'plan' : workspaceLayout);
    editor.setTool('calibrate');
    toast(t('hint.calibrateFirst'), 'info');
  } catch (e) {
    toast(t('load.underlayFailed', { reason: (e as Error).message }));
  }
}

editor.onCalibrated = () => toast(t('hint.calibrated'), 'info');

function savePlan(): void {
  const blob = new Blob([JSON.stringify(store.plan, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(store.plan.name || 'plan').replace(/[\\/:*?"<>|]+/g, '-')}.layout.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  savedRevision = store.revision;
}

// ---------------------------------------------------------------- top bar

const planSelect = $<HTMLSelectElement>('plan-select');
function renderPlanSelect(): void {
  const current = new Option(`${t('plan.autosaved')}: ${store.plan.name}`, '');
  const group = document.createElement('optgroup');
  group.label = t('plan.samples');
  group.append(...samples.map((s) => new Option(s.name, s.file)));
  planSelect.replaceChildren(current, group);
  planSelect.value = '';
}
planSelect.addEventListener('change', () => {
  const file = planSelect.value;
  planSelect.value = '';
  if (file && confirmReplace()) loadSample(file);
  renderPlanSelect();
});

$('new-plan').addEventListener('click', () => {
  if (!confirmReplace()) return;
  openPlan(emptyPlan(t('plan.untitled')));
  editor.setTool('rect');
});
const fileInput = $<HTMLInputElement>('file-input');
let fileTarget: 'open' | 'underlay' = 'open';
$('open-file').addEventListener('click', () => { fileTarget = 'open'; fileInput.click(); });
$('add-underlay').addEventListener('click', () => { fileTarget = 'underlay'; fileInput.click(); });
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (!f) return;
  if (fileTarget === 'underlay' && !/\.json$/i.test(f.name)) addUnderlay(f, false);
  else openFile(f);
});
$('save-file').addEventListener('click', savePlan);
$('undo').addEventListener('click', () => store.undo());
$('redo').addEventListener('click', () => store.redo());
function updateUndo(): void {
  $<HTMLButtonElement>('undo').disabled = !store.canUndo;
  $<HTMLButtonElement>('redo').disabled = !store.canRedo;
}

type LayoutMode = 'plan' | 'split' | '3d';
let workspaceLayout: LayoutMode = window.innerWidth < 900 ? 'plan' : 'split';
const layoutButtons = [...document.querySelectorAll<HTMLButtonElement>('#layout-modes button')];
function setLayout(mode: LayoutMode): void {
  const had3d = workspaceLayout !== 'plan' && workspace.dataset.layout !== undefined && $('stage').clientWidth > 0;
  workspaceLayout = mode;
  workspace.dataset.layout = mode;
  for (const b of layoutButtons) b.setAttribute('aria-pressed', String(b.dataset.layout === mode));
  // the 3D view was framed while hidden (no size): frame it again once it has one
  if (!had3d && mode !== 'plan' && shell && views.mode !== 'walk') requestAnimationFrame(() => { viewer.resize(); views.frameAll(true); });
}
for (const b of layoutButtons) b.addEventListener('click', () => setLayout(b.dataset.layout as LayoutMode));
setLayout(workspaceLayout);
$('panel-toggle').addEventListener('click', () => $('panel').classList.toggle('open'));

// ---------------------------------------------------------------- tool rail

const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('#tools [data-tool]')];
for (const b of toolButtons) b.addEventListener('click', () => editor.setTool(b.dataset.tool as Tool));
function reflectTool(tool: Tool): void {
  for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  for (const l of document.querySelectorAll<HTMLElement>('#tool-opts [data-for]')) l.hidden = !l.dataset.for!.split(' ').includes(tool);
  const opts = $('tool-opts');
  opts.hidden = ![...opts.children].some((c) => !(c as HTMLElement).hidden);
}
editor.onToolChange = reflectTool;
editor.onStatus = (text) => ($('status').textContent = text);
editor.setTool('select');

const wallKind = $<HTMLSelectElement>('opt-wall-kind');
wallKind.replaceChildren(...WALL_KINDS.map((k) => new Option(t(`wall.${k}`), k)));
const thickness = $<HTMLInputElement>('opt-thickness');
wallKind.value = editor.opts.wallKind;
thickness.value = String(Math.round(editor.opts.thickness * 100));
wallKind.addEventListener('change', () => {
  editor.opts.wallKind = wallKind.value as typeof editor.opts.wallKind;
  editor.opts.thickness = WALL_PRESETS[editor.opts.wallKind];
  thickness.value = String(Math.round(editor.opts.thickness * 100));
});
thickness.addEventListener('change', () => {
  const v = Number(thickness.value);
  if (v > 0) editor.opts.thickness = v / 100;
});
const roomType = $<HTMLSelectElement>('opt-room-type');
roomType.replaceChildren(...ROOM_TYPES.map((k) => new Option(t(`room.${k}`), k)));
roomType.value = editor.opts.roomType;
roomType.addEventListener('change', () => (editor.opts.roomType = roomType.value as typeof editor.opts.roomType));
for (const input of [thickness]) input.addEventListener('keydown', (e) => e.stopPropagation());
// after picking an option, keys go back to the plan (tool shortcuts, typed lengths)
for (const sel of [wallKind, roomType]) sel.addEventListener('change', () => editor.svg.focus({ preventScroll: true }));

const opacity = $<HTMLInputElement>('underlay-opacity');
opacity.addEventListener('input', () => { editor.underlayOpacity = Number(opacity.value); editor.render(); });
const visible = $<HTMLInputElement>('underlay-visible');
visible.addEventListener('change', () => { editor.underlayVisible = visible.checked; editor.render(); });
$('remove-underlay').addEventListener('click', () => {
  editor.setUnderlay(null);
  saveUnderlay(null);
  refreshUnderlayControls();
});
$('fit').addEventListener('click', () => editor.fit());
function refreshUnderlayControls(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-needs-underlay]')) el.hidden = !editor.underlay;
}

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target?.closest?.('input, select, textarea')) return;
  if (views.mode === 'walk' && !editor.pointerOver) return;
  if (workspaceLayout === '3d') return;
  if (editor.handleKey(e)) e.preventDefault();
});

// ---------------------------------------------------------------- side panel

function renderRooms(): void {
  const list = $('rooms');
  const level = shell?.levels[store.levelIndex];
  if (!level || !level.rooms.length) {
    const li = document.createElement('li');
    li.className = 'rooms__empty';
    li.textContent = t('panel.noRooms');
    list.replaceChildren(li);
    $('total-area').textContent = '';
    labels.set([], 0);
    return;
  }
  const rooms = [...level.rooms].sort((a, b) => b.area - a.area);
  list.replaceChildren(
    ...rooms.map((r) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      if (r.tag && store.isSelected('room', r.tag.id)) b.classList.add('active');
      const name = document.createElement('span');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      const mat = floorMaterial(r.type) as THREE.MeshStandardMaterial;
      sw.style.background = `#${mat.color.getHexString()}`;
      name.append(sw, r.tag ? roomName(r) : t('room.unnamed'));
      const area = document.createElement('span');
      area.className = 'area';
      area.textContent = t('unit.area', { v: formatNumber(r.area) });
      b.append(name, area);
      b.addEventListener('click', () => {
        store.select(r.tag ? { kind: 'room', id: r.tag.id } : { kind: 'loop', at: r.labelAt });
        views.focusOn(r.labelAt, Math.sqrt(r.area));
      });
      li.append(b);
      return li;
    }),
  );
  const total = level.rooms.filter((r) => r.type !== 'balcony').reduce((s, r) => s + r.area, 0);
  $('total-area').textContent = t('unit.area', { v: formatNumber(total) });
  labels.set(level.rooms, level.level.elevation);
}

function renderIssues(errors: Issue[], warnings: Issue[]): void {
  const list = $('issues');
  const item = (cls: string, issue: Issue | null, text: string) => {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    const id = issue?.id;
    if (id) {
      li.classList.add('link');
      li.addEventListener('click', () => {
        const l = store.level;
        const kind = l.walls.some((w) => w.id === id) ? 'wall' : l.openings.some((o) => o.id === id) ? 'opening'
          : l.nodes.some((n) => n.id === id) ? 'node' : l.rooms.some((r) => r.id === id) ? 'room' : null;
        if (kind) store.select({ kind, id });
      });
    }
    return li;
  };
  const rows = [
    ...errors.map((i) => item('error', i, t(i.key, i.params))),
    ...warnings.map((i) => item('warning', i, t(i.key, i.params))),
  ];
  list.replaceChildren(...(rows.length ? rows : [item('ok', null, t('panel.noIssues'))]));
}

let toastTimer = 0;
function toast(message?: string, kind: 'error' | 'info' = 'error'): void {
  const el = $('toast');
  window.clearTimeout(toastTimer);
  if (!message) { el.hidden = true; return; }
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  toastTimer = window.setTimeout(() => (el.hidden = true), kind === 'info' ? 7000 : 6000);
}

// ---------------------------------------------------------------- 3D controls

const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('#view-modes button')];
function reflectMode(mode: ViewMode): void {
  for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  const walkBtn = modeButtons.find((b) => b.dataset.mode === 'walk')!;
  walkBtn.textContent = t(mode === 'walk' ? 'view.exitWalk' : 'view.walk');
  $('hint').textContent = t(mode === 'walk' ? 'hint.walk' : 'hint.orbit');
}
views.onModeChange = reflectMode;
for (const b of modeButtons)
  b.addEventListener('click', () => {
    const mode = b.dataset.mode as ViewMode;
    if (mode === 'walk' && views.mode === 'walk') views.setMode('cutaway');
    else views.setMode(mode);
  });
reflectMode(views.mode);

const time = $<HTMLInputElement>('time');
function applyTime(): void {
  const h = Number(time.value);
  $('time-out').textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  viewer.setTimeOfDay(h, store.plan.north ?? 0);
}
time.addEventListener('input', applyTime);
applyTime();

const quality = $<HTMLSelectElement>('quality');
quality.value = viewer.quality;
quality.addEventListener('change', () => viewer.setQuality(quality.value as Quality));

// ---------------------------------------------------------------- drag and drop

const drop = $('drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

// ---------------------------------------------------------------- per frame

const statsEl = $('stats');
let statsTimer = 0;
viewer.onFrame((dt) => {
  labels.update(viewer.camera, views.mode !== 'walk');
  statsTimer -= dt;
  if (statsTimer <= 0) {
    statsTimer = 0.5;
    const s = viewer.getStats();
    statsEl.textContent = `${t('stats.fps', { fps: s.fps })} · ${t('stats.detail', { calls: s.calls, tris: Math.round(s.triangles / 1000) })}`;
  }
});

// ---------------------------------------------------------------- start

(async () => {
  samples = await loadSampleList();
  renderPlanSelect();
  const wanted = new URLSearchParams(location.search).get('plan');
  const sample = samples.find((s) => s.file === wanted)?.file;
  if (sample) await loadSample(sample);
  else if (!Store.restore() && samples[0]) await loadSample(samples[0].file);
  else {
    const u = store.plan.source?.transform ? await restoreUnderlay() : null;
    if (u) editor.setUnderlay(u);
    rebuild(false);
    editor.fit();
  }
  refreshUnderlayControls();
  updateUndo();
})();

// handy for debugging in the browser console
Object.assign(window, { layout: { viewer, views, store, editor, get shell() { return shell; } } });
