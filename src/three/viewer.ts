// Renderer, real-time lighting (sky, sun, sky-based environment, ambient occlusion) and the frame loop.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { N8AOPass } from 'n8ao';
import { MATERIALS } from './materials';

export type Quality = 'high' | 'low';

export interface FrameStats {
  fps: number;
  calls: number;
  triangles: number;
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun = new THREE.DirectionalLight(0xfff4e5, 3);
  private readonly hemi = new THREE.HemisphereLight(0xdfe8f2, 0x8a8170, 0.35);
  private readonly sky = new Sky();
  /** A second sky in its own scene, captured into the environment map. */
  private readonly envSky = new Sky();
  private readonly skyScene = new THREE.Scene();
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget?: THREE.WebGLRenderTarget;
  private envDirty = true;
  private envTimer = 0;
  private readonly ground: THREE.Mesh;
  private composer?: EffectComposer;
  private _quality: Quality = 'high';
  private focus = new THREE.Vector3();
  private radius = 10;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private updaters: ((dt: number) => void)[] = [];
  private frames = 0;
  private fpsTime = 0;
  private stats: FrameStats = { fps: 0, calls: 0, triangles: 0 };
  private clock = new THREE.Timer();

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 6000);
    this.camera.position.set(12, 16, 18);

    // sky drawn as the background and also used as the environment light
    for (const sky of [this.sky, this.envSky]) {
      sky.scale.setScalar(2500);
      const u = sky.material.uniforms;
      u.turbidity.value = 4;
      u.rayleigh.value = 1.2;
      u.mieCoefficient.value = 0.004;
      u.mieDirectionalG.value = 0.8;
      if (u.cloudCoverage) u.cloudCoverage.value = 0.25;
    }
    this.skyScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.add(this.sky);

    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.ground = new THREE.Mesh(new THREE.CircleGeometry(1, 64), MATERIALS.ground);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.name = 'ground';
    this.scene.add(this.ground);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
    this.setQuality(Viewer.autoQuality(this.renderer));
    this.renderer.setAnimationLoop(() => this.frame());
  }

  static autoQuality(renderer: THREE.WebGLRenderer): Quality {
    const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const cores = navigator.hardwareConcurrency ?? 4;
    const maxTex = renderer.capabilities.maxTextureSize;
    return mobile || cores <= 4 || maxTex < 8192 ? 'low' : 'high';
  }

  get quality(): Quality {
    return this._quality;
  }

  setQuality(q: Quality): void {
    this._quality = q;
    const dpr = Math.min(window.devicePixelRatio || 1, q === 'high' ? 2 : 1);
    this.renderer.setPixelRatio(dpr);
    const size = q === 'high' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.composer?.dispose();
    this.composer = undefined;
    if (q === 'high') {
      const { w, h } = this.size();
      const composer = new EffectComposer(this.renderer);
      const ao = new N8AOPass(this.scene, this.camera, w, h);
      ao.configuration.aoRadius = 0.6;
      ao.configuration.distanceFalloff = 0.6;
      ao.configuration.intensity = 2.2;
      ao.configuration.aoSamples = 16;
      ao.configuration.denoiseSamples = 8;
      ao.configuration.denoiseRadius = 8;
      ao.configuration.halfRes = dpr > 1.25;
      ao.configuration.gammaCorrection = false;
      ao.configuration.transparencyAware = true;
      composer.addPass(ao);
      composer.addPass(new SMAAPass());
      composer.addPass(new OutputPass());
      this.composer = composer;
    }
    this.resize();
  }

  /** Frame the building: sizes the ground, shadow camera and camera limits to it. */
  setFocus(box: THREE.Box3): void {
    box.getCenter(this.focus);
    const size = box.getSize(new THREE.Vector3());
    this.radius = Math.max(4, 0.5 * Math.hypot(size.x, size.z));
    this.ground.scale.setScalar(this.radius * 6);
    this.ground.position.set(this.focus.x, box.min.y - 0.01, this.focus.z);
    const cam = this.sun.shadow.camera;
    const r = this.radius + 1.5;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 0.5; cam.far = r * 6;
    cam.updateProjectionMatrix();
    this.placeSun();
  }

  /**
   * Sun from a time of day (6–20 h) on a simple arc: east in the morning, south at midday, west in the
   * evening. `north` is the plan's north angle (clockwise from plan +y).
   */
  setTimeOfDay(hours: number, north = 0): void {
    const t = THREE.MathUtils.clamp((hours - 6) / 14, 0, 1);
    const azimuth = THREE.MathUtils.degToRad(90 + 180 * t + north); // from plan +y, clockwise
    const elevation = THREE.MathUtils.degToRad(Math.max(3, 62 * Math.sin(Math.PI * t)));
    const ce = Math.cos(elevation);
    // plan (sin A, cos A) → 3D (x, ·, -y)
    this.sunDir.set(Math.sin(azimuth) * ce, Math.sin(elevation), -Math.cos(azimuth) * ce).normalize();
    const low = 1 - Math.min(1, elevation / THREE.MathUtils.degToRad(25));
    this.sun.color.setRGB(1, 0.95 - 0.25 * low, 0.88 - 0.45 * low);
    this.sun.intensity = 1.2 + 2.3 * (1 - low);
    this.hemi.intensity = 0.25 + 0.15 * (1 - low);
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    this.envSky.material.uniforms.sunPosition.value.copy(this.sunDir);
    this.placeSun();
    this.envDirty = true;
  }

  private placeSun(): void {
    this.sun.target.position.copy(this.focus);
    this.sun.position.copy(this.focus).addScaledVector(this.sunDir, this.radius * 3);
    this.sun.target.updateMatrixWorld();
  }

  onFrame(fn: (dt: number) => void): void {
    this.updaters.push(fn);
  }

  getStats(): FrameStats {
    return this.stats;
  }

  private size() {
    return { w: Math.max(1, this.host.clientWidth), h: Math.max(1, this.host.clientHeight) };
  }

  private resize(): void {
    const { w, h } = this.size();
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
  }

  private updateEnvironment(dt: number): void {
    this.envTimer -= dt;
    if (!this.envDirty || this.envTimer > 0) return;
    this.envDirty = false;
    this.envTimer = 0.25; // regenerate at most four times a second while the sun moves
    const next = this.pmrem.fromScene(this.skyScene, 0, 1, 5000);
    this.envTarget?.dispose();
    this.envTarget = next;
    this.scene.environment = next.texture;
    this.scene.environmentIntensity = 0.25;
  }

  private frame(): void {
    this.clock.update();
    const dt = Math.min(0.1, this.clock.getDelta());
    for (const fn of this.updaters) fn(dt);
    this.updateEnvironment(dt);
    this.renderer.info.reset();
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.stats = {
        fps: Math.round(this.frames / this.fpsTime),
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
      };
      this.frames = 0;
      this.fpsTime = 0;
    }
  }
}
