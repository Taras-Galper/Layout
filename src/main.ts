import './style.css';
import * as THREE from 'three';
import { formatNumber, setLanguage, t, translateDom } from './i18n';
import type { Plan } from './model/plan';
import { type Issue, validatePlan } from './model/validate';
import { Viewer, type Quality } from './three/viewer';
import { Views, type ViewMode } from './three/views';
import { buildShell, disposeShell, type ShellBuild } from './three/shell';
import { floorMaterial } from './three/materials';
import { RoomLabels, roomName } from './ui/labels';

setLanguage('en');
translateDom();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');
const viewer = new Viewer(stage);
const views = new Views(viewer);
const labels = new RoomLabels($('labels'), (room) => views.focusOn(room.labelAt, Math.sqrt(room.area)));

let plan: Plan | undefined;
let shell: ShellBuild | undefined;
let activeLevel = 0;

// ---------------------------------------------------------------- loading

async function loadSampleList(): Promise<{ file: string; name: string }[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}plans/index.json`);
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

async function loadSample(file: string): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}plans/${file}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    showPlan(await res.json());
  } catch (e) {
    toast(t('load.failed', { reason: (e as Error).message }));
  }
}

function loadFile(file: File): void {
  file.text().then(
    (text) => {
      try {
        showPlan(JSON.parse(text));
        const select = $<HTMLSelectElement>('plan-select');
        let opt = [...select.options].find((o) => o.value === `file:${file.name}`);
        if (!opt) {
          opt = new Option(file.name, `file:${file.name}`);
          select.add(opt);
        }
        select.value = opt.value;
      } catch (e) {
        toast(t('load.failed', { reason: (e as Error).message }));
      }
    },
    (e) => toast(t('load.failed', { reason: String(e) })),
  );
}

function showPlan(input: unknown): void {
  const result = validatePlan(input);
  if (!result.ok) {
    renderIssues(result.errors, result.warnings);
    toast(t('load.invalid'));
    return;
  }
  plan = input as Plan;
  if (shell) disposeShell(shell);
  shell = buildShell(plan);
  viewer.scene.add(shell.group);
  viewer.setFocus(shell.box);
  activeLevel = 0;
  setupLevels();
  views.setShell(shell, activeLevel);
  applyTime();
  renderRooms();
  const extra: Issue[] = [];
  for (const l of shell.levels) {
    if (l.untagged) extra.push({ level: l.level.id, key: 'panel.untagged', params: { n: l.untagged } });
    for (const tag of l.orphanTags) extra.push({ level: l.level.id, key: 'issue.orphanTag', params: { name: tag.name ?? t(`room.${tag.type}`) } });
  }
  renderIssues(result.errors, [...result.warnings, ...extra]);
  toast();
}

function setupLevels(): void {
  const field = $('level-field');
  const select = $<HTMLSelectElement>('level-select');
  const levels = plan?.levels ?? [];
  field.hidden = levels.length < 2;
  select.replaceChildren(...levels.map((l, i) => new Option(l.name, String(i))));
  select.value = String(activeLevel);
}

// ---------------------------------------------------------------- panels

function renderRooms(): void {
  const list = $('rooms');
  const level = shell?.levels[activeLevel];
  $('plan-name').textContent = plan?.name ?? '';
  if (!level) { list.replaceChildren(); return; }
  const rooms = [...level.rooms].sort((a, b) => b.area - a.area);
  list.replaceChildren(
    ...rooms.map((r) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const name = document.createElement('span');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      const mat = floorMaterial(r.type) as THREE.MeshStandardMaterial;
      sw.style.background = `#${mat.color.getHexString()}`;
      name.append(sw, roomName(r));
      const area = document.createElement('span');
      area.className = 'area';
      area.textContent = t('unit.area', { v: formatNumber(r.area) });
      b.append(name, area);
      b.addEventListener('click', () => views.focusOn(r.labelAt, Math.sqrt(r.area)));
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
  const item = (cls: string, text: string) => {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    return li;
  };
  const rows = [
    ...errors.map((i) => item('error', t(i.key, i.params))),
    ...warnings.map((i) => item('warning', t(i.key, i.params))),
  ];
  list.replaceChildren(...(rows.length ? rows : [item('ok', t('panel.noIssues'))]));
}

let toastTimer = 0;
function toast(message?: string): void {
  const el = $('toast');
  window.clearTimeout(toastTimer);
  if (!message) { el.hidden = true; return; }
  el.textContent = message;
  el.hidden = false;
  toastTimer = window.setTimeout(() => (el.hidden = true), 6000);
}

// ---------------------------------------------------------------- controls

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
  viewer.setTimeOfDay(h, plan?.north ?? 0);
}
time.addEventListener('input', applyTime);
applyTime();

const quality = $<HTMLSelectElement>('quality');
quality.value = viewer.quality;
quality.addEventListener('change', () => viewer.setQuality(quality.value as Quality));

$<HTMLSelectElement>('level-select').addEventListener('change', (e) => {
  activeLevel = Number((e.target as HTMLSelectElement).value);
  views.setActiveLevel(activeLevel);
  renderRooms();
});

$('panel-toggle').addEventListener('click', () => $('panel').classList.toggle('open'));

const fileInput = $<HTMLInputElement>('file-input');
$('open-file').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
  fileInput.value = '';
});

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
  if (f) loadFile(f);
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
  const samples = await loadSampleList();
  const select = $<HTMLSelectElement>('plan-select');
  select.replaceChildren(...samples.map((s) => new Option(s.name, s.file)));
  select.addEventListener('change', () => {
    if (!select.value.startsWith('file:')) loadSample(select.value);
  });
  const wanted = new URLSearchParams(location.search).get('plan');
  const first = samples.find((s) => s.file === wanted)?.file ?? samples[0]?.file;
  if (first) {
    select.value = first;
    await loadSample(first);
  }
})();

// handy for debugging in the browser console
Object.assign(window, { layout: { viewer, views, get plan() { return plan; }, get shell() { return shell; } } });
