// Room name tags floating over the 3D view.
import * as THREE from 'three';
import { formatNumber, t } from '../i18n';
import type { Room } from '../model/topology';

export function roomName(r: Room): string {
  return r.name?.trim() || t(`room.${r.type}`);
}

export class RoomLabels {
  private items: { el: HTMLElement; pos: THREE.Vector3 }[] = [];
  private readonly v = new THREE.Vector3();

  constructor(private readonly host: HTMLElement, private readonly onPick: (room: Room) => void) {}

  set(rooms: Room[], elevation: number): void {
    this.host.replaceChildren();
    this.items = rooms.map((r) => {
      const el = document.createElement('button');
      el.className = 'room-label';
      el.type = 'button';
      const name = document.createElement('span');
      name.className = 'room-label__name';
      name.textContent = roomName(r);
      const area = document.createElement('span');
      area.className = 'room-label__area';
      area.textContent = t('unit.area', { v: formatNumber(r.area) });
      el.append(name, area);
      el.addEventListener('click', () => this.onPick(r));
      this.host.appendChild(el);
      return { el, pos: new THREE.Vector3(r.labelAt[0], elevation + 0.05, -r.labelAt[1]) };
    });
  }

  update(camera: THREE.Camera, visible: boolean): void {
    this.host.hidden = !visible;
    if (!visible) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    for (const it of this.items) {
      this.v.copy(it.pos).project(camera);
      const show = this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1;
      it.el.style.display = show ? '' : 'none';
      if (show) it.el.style.transform = `translate(${((this.v.x + 1) / 2) * w}px, ${((1 - this.v.y) / 2) * h}px) translate(-50%, -50%)`;
    }
  }
}
