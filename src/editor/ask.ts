// A small input box that floats at a point on the editor, for typed lengths and calibration.
import { t } from '../i18n';

export class Ask {
  private box?: HTMLDivElement;
  private done?: (v: string | null) => void;

  constructor(private readonly host: HTMLElement) {}

  get open(): boolean {
    return !!this.box;
  }

  /** Shows the box at (x, y) in host pixels; resolves with the text, or null when cancelled. */
  ask(label: string, at: { x: number; y: number }, initial = '', hint = '', selectAll = true): Promise<string | null> {
    this.close(null);
    const box = document.createElement('div');
    box.className = 'ask';
    box.style.left = `${Math.min(at.x + 14, this.host.clientWidth - 220)}px`;
    box.style.top = `${Math.min(at.y + 14, this.host.clientHeight - 90)}px`;
    const l = document.createElement('label');
    l.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = initial;
    input.autocomplete = 'off';
    l.append(input);
    box.append(l);
    if (hint) {
      const h = document.createElement('small');
      h.textContent = hint;
      box.append(h);
    }
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = t('ask.ok');
    box.append(ok);
    this.host.append(box);
    this.box = box;
    const p = new Promise<string | null>((res) => (this.done = res));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.close(input.value);
      if (e.key === 'Escape') this.close(null);
    });
    ok.addEventListener('click', () => this.close(input.value));
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    // focus at once, so the keys typed right after opening land in the box
    const focus = () => {
      if (document.activeElement === input) return;
      input.focus({ preventScroll: true });
      if (selectAll) input.select();
      else input.setSelectionRange(input.value.length, input.value.length);
    };
    focus();
    // a click that opened the box may still move the focus when its mouse events finish
    setTimeout(focus, 0);
    return p;
  }

  close(v: string | null): void {
    const done = this.done;
    this.box?.remove();
    this.box = undefined;
    this.done = undefined;
    done?.(v);
  }
}

/**
 * A typed length in metres: "3.2", "3,2", "3.2m", "320cm", "3200mm". A plain number of 30 or more is
 * read as centimetres, since no wall is that long in metres and plans usually give centimetres.
 */
export function parseLength(s: string): number | null {
  const m = s.trim().toLowerCase().replace(',', '.').match(/^(-?\d*\.?\d+)\s*(mm|cm|m)?$/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  const unit = m[2] ?? (v >= 30 ? 'cm' : 'm');
  return unit === 'mm' ? v / 1000 : unit === 'cm' ? v / 100 : v;
}
