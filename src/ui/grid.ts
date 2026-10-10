// The zone grid: renders 2×2 (basic) or 2×3 (pro) zones and turns touches into
// "tap = listen" and "hold = select". The bottom-right zone is always the menu.

import { HoldTone, sfx, vibrate } from '../audio/sfx';

export interface ZoneView {
  text: string;
  color: string;
  /** Zone is empty: tapping says so, holding does nothing. */
  empty?: boolean;
}

export interface GridHandlers {
  tap(index: number): void;
  select(index: number): void;
  menuTap(): void;
  menuHold(): void;
  /** Menu zone held for the long "settings" duration. */
  menuLongHold(): void;
  /** Any touch at all (used for idle tracking and audio unlock). */
  touch(): void;
}

/** Zone colours; green and red are reserved for answer feedback. */
export const ZONE_COLORS = ['#ffd400', '#2f7bff', '#b45cff', '#ff8c1a', '#22d3ee'];
export const MENU_COLOR = '#f2f2f2';
export const SETTINGS_HOLD_MS = 5000;
/** Releases shorter than this are taps even if a hold had started. */
const TAP_MAX_MS = 600;

export class Grid {
  readonly root: HTMLElement;
  private zones: HTMLElement[] = [];
  private tone = new HoldTone();
  private active: { pointerId: number; index: number; start: number; selected: boolean; timers: number[] } | null = null;
  holdMs = 2000;
  private slots = 3;
  private focus = -1;

  constructor(
    parent: HTMLElement,
    private h: GridHandlers,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'grid';
    this.root.setAttribute('role', 'application');
    this.root.setAttribute('aria-roledescription', 'зоны');
    parent.appendChild(this.root);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Number of option slots (3 basic, 5 pro). The menu zone is added after them. */
  get slotCount(): number {
    return this.slots;
  }

  render(views: ZoneView[], slots: number): void {
    this.cancel();
    this.slots = slots;
    this.root.classList.toggle('pro', slots === 5);
    this.root.textContent = '';
    this.zones = [];
    for (let i = 0; i <= slots; i++) {
      const isMenu = i === slots;
      const v: ZoneView = isMenu ? { text: 'Меню', color: MENU_COLOR } : (views[i] ?? { text: '', color: '#000', empty: true });
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'zone' + (isMenu ? ' menu' : '') + (v.empty ? ' empty' : '');
      el.style.setProperty('--zc', v.empty ? '#111' : v.color);
      el.dataset.index = String(i);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = v.text;
      const len = v.text.length;
      label.classList.add(len <= 6 ? 'xl' : len <= 14 ? 'l' : len <= 28 ? 'm' : 's');
      const fill = document.createElement('span');
      fill.className = 'fill';
      el.append(fill, label);
      el.setAttribute('aria-label', isMenu ? 'Меню' : v.empty ? 'Пусто' : v.text);
      el.addEventListener('pointerdown', (e) => this.down(e, i));
      el.addEventListener('pointerup', (e) => this.up(e));
      el.addEventListener('pointercancel', (e) => this.up(e, true));
      el.addEventListener('pointermove', (e) => this.move(e));
      // Screen-reader / keyboard activation (click without pointer events).
      el.addEventListener('click', (e) => {
        if ((e as MouseEvent).detail === 0) this.keyActivate(i);
      });
      this.root.appendChild(el);
      this.zones.push(el);
    }
  }

  private isMenu(i: number): boolean {
    return i === this.slots;
  }

  private down(e: PointerEvent, i: number): void {
    e.preventDefault();
    this.h.touch();
    if (this.active) return; // ignore extra fingers
    const el = this.zones[i];
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom */
    }
    const empty = el.classList.contains('empty');
    const a = { pointerId: e.pointerId, index: i, start: performance.now(), selected: false, timers: [] as number[] };
    this.active = a;
    if (empty) return;
    el.classList.add('holding');
    el.style.setProperty('--hold', `${this.holdMs}ms`);
    // Start the visual/audio hold feedback only after a short delay so quick taps stay quiet.
    a.timers.push(
      window.setTimeout(() => {
        if (this.active !== a) return;
        el.classList.add('filling');
        this.tone.start(this.holdMs - 150);
      }, 150),
    );
    const ticks = Math.max(1, Math.floor(this.holdMs / 400));
    for (let k = 1; k < ticks; k++) a.timers.push(window.setTimeout(() => this.active === a && sfx.tick(), k * 400));
    a.timers.push(
      window.setTimeout(() => {
        if (this.active !== a) return;
        a.selected = true;
        this.tone.stop();
        sfx.select();
        el.classList.add('selected');
        if (this.isMenu(i)) {
          // Keep holding for settings; menu opens on release.
          a.timers.push(
            window.setTimeout(() => {
              if (this.active !== a) return;
              vibrate([80, 60, 80, 60, 200]);
              this.finish();
              this.h.menuLongHold();
            }, SETTINGS_HOLD_MS - this.holdMs),
          );
        } else {
          this.finish();
          this.h.select(i);
        }
      }, this.holdMs),
    );
  }

  private move(e: PointerEvent): void {
    const a = this.active;
    if (!a || a.pointerId !== e.pointerId || a.selected) return;
    const r = this.zones[a.index].getBoundingClientRect();
    const m = 12;
    if (e.clientX < r.left - m || e.clientX > r.right + m || e.clientY < r.top - m || e.clientY > r.bottom + m) {
      // Finger slid off the zone: cancel silently.
      this.finish();
    }
  }

  private up(e: PointerEvent, cancelled = false): void {
    const a = this.active;
    if (!a || a.pointerId !== e.pointerId) return;
    const dur = performance.now() - a.start;
    const i = a.index;
    const wasSelected = a.selected;
    this.finish();
    if (cancelled) return;
    if (this.isMenu(i)) {
      if (wasSelected) this.h.menuHold();
      else if (dur < this.holdMs) this.h.menuTap();
      return;
    }
    if (!wasSelected && (dur < TAP_MAX_MS || dur < this.holdMs)) this.h.tap(i);
  }

  private finish(): void {
    const a = this.active;
    if (!a) return;
    a.timers.forEach((t) => clearTimeout(t));
    this.tone.stop();
    const el = this.zones[a.index];
    el?.classList.remove('holding', 'filling', 'selected');
    this.active = null;
  }

  cancel(): void {
    this.finish();
  }

  // ---- Keyboard / external clicker support ------------------------------------
  // Arrows move between zones and speak them, Enter/Space selects, Escape opens the
  // pause menu, digits 1–6 speak a zone directly.

  private onKey(e: KeyboardEvent): void {
    if (document.querySelector('.overlay.open')) return;
    const n = this.slots + 1;
    const cols = 2;
    let f = this.focus < 0 ? 0 : this.focus;
    switch (e.key) {
      case 'ArrowRight':
        f = (f + 1) % n;
        break;
      case 'ArrowLeft':
        f = (f - 1 + n) % n;
        break;
      case 'ArrowDown':
        f = (f + cols) % n;
        break;
      case 'ArrowUp':
        f = (f - cols + n) % n;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.h.touch();
        if (this.focus >= 0) this.keyActivate(this.focus);
        return;
      case 'Escape':
        this.h.touch();
        this.h.menuHold();
        return;
      default:
        if (/^[1-6]$/.test(e.key) && Number(e.key) <= n) {
          f = Number(e.key) - 1;
          break;
        }
        return;
    }
    e.preventDefault();
    this.h.touch();
    this.setFocus(f);
    if (this.isMenu(f)) this.h.menuTap();
    else this.h.tap(f);
  }

  private setFocus(f: number): void {
    this.zones.forEach((z, k) => z.classList.toggle('kfocus', k === f));
    this.focus = f;
  }

  private keyActivate(i: number): void {
    if (this.zones[i]?.classList.contains('empty')) {
      this.h.tap(i);
      return;
    }
    sfx.select();
    if (this.isMenu(i)) this.h.menuHold();
    else this.h.select(i);
  }

  resetFocus(): void {
    this.focus = -1;
    this.zones.forEach((z) => z.classList.remove('kfocus'));
  }
}
