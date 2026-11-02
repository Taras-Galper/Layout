// View modes: cutaway (walls facing the camera drop), walls up, walls down, and walking.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Vec2 } from '../model/plan';
import { closestOnSegment } from '../model/geometry';
import type { ShellBuild } from './shell';
import type { Viewer } from './viewer';

export type ViewMode = 'cutaway' | 'wallsUp' | 'wallsDown' | 'walk';

const CUT_HEIGHT = 0.9;
const EYE = 1.6;
const RADIUS = 0.22;
const SPEED = 1.6;

export class Views {
  readonly orbit: OrbitControls;
  private shell?: ShellBuild;
  private _mode: ViewMode = 'cutaway';
  private beforeWalk: ViewMode = 'cutaway';
  private savedOrbit?: { position: THREE.Vector3; target: THREE.Vector3 };
  private yaw = 0;
  private pitch = 0;
  private keys = new Set<string>();
  private dragging = false;
  private last: [number, number] = [0, 0];
  private activeLevel = 0;
  private flyTo?: { from: THREE.Vector3; to: THREE.Vector3; fromPos: THREE.Vector3; toPos: THREE.Vector3; t: number };
  private readonly raycaster = new THREE.Raycaster();
  onModeChange?: (mode: ViewMode) => void;

  constructor(private readonly viewer: Viewer) {
    const canvas = viewer.renderer.domElement;
    this.orbit = new OrbitControls(viewer.camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = THREE.MathUtils.degToRad(84);
    this.orbit.screenSpacePanning = false;

    canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    canvas.addEventListener('pointerdown', (e) => {
      if (this._mode !== 'walk') return;
      this.dragging = true;
      this.last = [e.clientX, e.clientY];
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this._mode !== 'walk' || !this.dragging) return;
      this.yaw -= (e.clientX - this.last[0]) * 0.0042;
      this.pitch = THREE.MathUtils.clamp(this.pitch - (e.clientY - this.last[1]) * 0.0042, -1.2, 1.2);
      this.last = [e.clientX, e.clientY];
    });
    const up = () => (this.dragging = false);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
      if (e.key === 'Escape' && this._mode === 'walk') this.setMode(this.beforeWalk);
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    viewer.onFrame((dt) => this.update(dt));
  }

  get mode(): ViewMode {
    return this._mode;
  }

  setShell(shell: ShellBuild, activeLevel = 0): void {
    this.shell = shell;
    this.activeLevel = Math.min(activeLevel, shell.levels.length - 1);
    if (this._mode === 'walk') this.setMode('cutaway');
    this.applyCeilings();
    this.applyLevelVisibility();
    this.frameAll(true);
  }

  setActiveLevel(i: number): void {
    this.activeLevel = i;
    this.applyLevelVisibility();
  }

  /** Levels above the active one are hidden, like lifting the roof off. */
  private applyLevelVisibility(): void {
    this.shell?.levels.forEach((l, i) => (l.group.visible = i <= this.activeLevel));
  }

  private get level() {
    return this.shell?.levels[this.activeLevel];
  }

  /** Put the orbit camera where the whole level is in view. */
  frameAll(instant = false): void {
    if (!this.shell) return;
    const box = this.shell.box;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(4, 0.5 * Math.hypot(size.x, size.z));
    const fov = THREE.MathUtils.degToRad(this.viewer.camera.fov);
    const d = (r / Math.sin(fov / 2)) * 1.05;
    const target = new THREE.Vector3(center.x, (this.level?.level.elevation ?? 0), center.z);
    const pos = target.clone().add(new THREE.Vector3(-0.55, 0.78, 0.62).normalize().multiplyScalar(d));
    this.orbit.minDistance = 2;
    this.orbit.maxDistance = d * 3;
    this.moveCamera(target, pos, instant);
  }

  /** Centre the orbit on a plan point (room focus). */
  focusOn(p: Vec2, extent = 4): void {
    if (this._mode === 'walk') this.setMode(this.beforeWalk);
    const elev = this.level?.level.elevation ?? 0;
    const target = new THREE.Vector3(p[0], elev, -p[1]);
    const dir = this.viewer.camera.position.clone().sub(this.orbit.target).normalize();
    const d = Math.max(5, extent * 2.2);
    this.moveCamera(target, target.clone().addScaledVector(dir, d), false);
  }

  private moveCamera(target: THREE.Vector3, pos: THREE.Vector3, instant: boolean) {
    if (instant) {
      this.orbit.target.copy(target);
      this.viewer.camera.position.copy(pos);
      this.orbit.update();
      this.flyTo = undefined;
      return;
    }
    this.flyTo = { from: this.orbit.target.clone(), to: target, fromPos: this.viewer.camera.position.clone(), toPos: pos, t: 0 };
  }

  setMode(mode: ViewMode, walkAt?: Vec2, lookFrom?: THREE.Vector3): void {
    if (mode === this._mode && mode !== 'walk') return;
    const cam = this.viewer.camera;
    if (mode === 'walk') {
      if (this._mode !== 'walk') {
        this.beforeWalk = this._mode;
        this.savedOrbit = { position: cam.position.clone(), target: this.orbit.target.clone() };
      }
      const at = walkAt ?? this.defaultWalkPoint();
      const elev = this.level?.level.elevation ?? 0;
      cam.position.set(at[0], elev + EYE, -at[1]);
      const from = lookFrom ?? this.savedOrbit?.position ?? cam.position;
      const look = new THREE.Vector3(cam.position.x - from.x, 0, cam.position.z - from.z);
      this.yaw = look.lengthSq() > 1e-6 ? Math.atan2(-look.x, -look.z) : 0;
      this.pitch = -0.05;
      this.orbit.enabled = false;
      this.flyTo = undefined;
      cam.near = 0.05;
    } else {
      if (this._mode === 'walk' && this.savedOrbit) {
        cam.position.copy(this.savedOrbit.position);
        this.orbit.target.copy(this.savedOrbit.target);
      }
      this.orbit.enabled = true;
      this.orbit.update();
    }
    cam.updateProjectionMatrix();
    this._mode = mode;
    this.applyCeilings();
    this.onModeChange?.(mode);
  }

  /** Ceilings exist only while walking; from above they would hide the rooms and shade them. */
  private applyCeilings(): void {
    const walking = this._mode === 'walk';
    for (const l of this.shell?.levels ?? [])
      for (const c of l.ceilings) { c.visible = walking; c.castShadow = walking; }
  }

  private defaultWalkPoint(): Vec2 {
    const rooms = this.level?.rooms ?? [];
    const pick = rooms.find((r) => r.type === 'entry') ?? rooms.find((r) => r.type === 'living') ?? rooms[0];
    return pick ? pick.labelAt : [0, 0];
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this._mode === 'walk' || !this.level) return;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    const hit = this.raycaster.intersectObjects(this.level.floors, false)[0];
    if (!hit) return;
    this.setMode('walk', [hit.point.x, -hit.point.z], this.viewer.camera.position.clone());
  }

  private update(dt: number): void {
    const cam = this.viewer.camera;
    if (this.flyTo) {
      const f = this.flyTo;
      f.t = Math.min(1, f.t + dt / 0.6);
      const k = f.t * f.t * (3 - 2 * f.t);
      this.orbit.target.lerpVectors(f.from, f.to, k);
      cam.position.lerpVectors(f.fromPos, f.toPos, k);
      if (f.t >= 1) this.flyTo = undefined;
    }
    if (this._mode === 'walk') this.walk(dt);
    else this.orbit.update();
    this.updateWalls(dt);
  }

  private walk(dt: number): void {
    const cam = this.viewer.camera;
    const k = this.keys;
    let fwd = 0, strafe = 0;
    if (k.has('w') || k.has('arrowup')) fwd += 1;
    if (k.has('s') || k.has('arrowdown')) fwd -= 1;
    if (k.has('d') || k.has('arrowright')) strafe += 1;
    if (k.has('a') || k.has('arrowleft')) strafe -= 1;
    if (k.has('q')) this.yaw += dt * 1.8;
    if (k.has('e')) this.yaw -= dt * 1.8;
    if (fwd || strafe) {
      const speed = SPEED * (k.has('shift') ? 2.2 : 1) * dt;
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      // camera looks along (-sin yaw, -cos yaw) in 3D x/z
      const dx = (-sin * fwd + cos * strafe) * speed, dz = (-cos * fwd - sin * strafe) * speed;
      const next = this.collide([cam.position.x + dx, -(cam.position.z + dz)]);
      cam.position.x = next[0];
      cam.position.z = -next[1];
    }
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  /** Push a plan point out of every wall it overlaps (circle against wall outlines). */
  private collide(p: Vec2): Vec2 {
    const blockers = this.level?.blockers ?? [];
    let q: Vec2 = [p[0], p[1]];
    for (let iter = 0; iter < 3; iter++) {
      for (const poly of blockers) {
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          const { point, d } = closestOnSegment(q, a, b);
          if (d < RADIUS && d > 1e-9) {
            const push = (RADIUS - d) / d;
            q = [q[0] + (q[0] - point[0]) * push, q[1] + (q[1] - point[1]) * push];
          }
        }
      }
    }
    return q;
  }

  private updateWalls(dt: number): void {
    const level = this.level;
    if (!level) return;
    const cam = this.viewer.camera;
    const t = this.orbit.target;
    const camFlat = new THREE.Vector3(cam.position.x - t.x, 0, cam.position.z - t.z);
    const hasDir = camFlat.lengthSq() > 1e-4;
    camFlat.normalize();
    const elev = level.level.elevation;
    const k = 1 - Math.exp(-dt * 10);
    for (const w of level.walls) {
      let target = 1;
      const low = Math.min(1, CUT_HEIGHT / w.height);
      if (this._mode === 'wallsDown') target = low;
      else if (this._mode === 'cutaway' && hasDir) {
        // walls on the camera's side of the view centre drop
        const d = (w.center.x - t.x) * camFlat.x + (w.center.z - t.z) * camFlat.z;
        if (d > 0.2 && cam.position.y > elev + 1.0) target = low;
      }
      w.target = target;
      w.scale += (w.target - w.scale) * k;
      if (Math.abs(w.scale - w.target) < 1e-3) w.scale = w.target;
      w.group.scale.y = w.scale;
    }
  }
}
