// Interaction controller: shows a set of options on the grid, speaks the prompt and waits
// for the learner to select one. Handles repeat, idle reminders, auto-pause, the pause
// menu and the hidden settings gesture.

import type { Player } from '../audio/player';
import { sfx } from '../audio/sfx';
import type { Utt } from '../types';
import { Grid, ZONE_COLORS } from './grid';

export interface Option {
  text: string;
  say: Utt[];
  color?: string;
  empty?: boolean;
}

export interface AskSpec {
  prompt: Utt[];
  options: (Option | null)[];
  /** Playback rate for the prompt (e.g. 0.75 for "slowly"). */
  rate?: number;
  /** Do not speak the prompt on first display (it was just spoken). */
  silentStart?: boolean;
  /** Disable idle reminders and auto-pause (e.g. while waiting for downloads). */
  noIdle?: boolean;
  /** Menu zone hold does nothing (used inside the pause menu itself). */
  noPause?: boolean;
}

export type Route =
  | { name: 'start' }
  | { name: 'main' }
  | { name: 'continue' }
  | { name: 'choose' }
  | { name: 'lesson'; id: string }
  | { name: 'review' }
  | { name: 'progress' }
  | { name: 'command' }
  | { name: 'talk' }
  | { name: 'tutorial' };

/** Thrown to abandon the current flow and go somewhere else. */
export class Navigate extends Error {
  constructor(public route: Route) {
    super('navigate');
  }
}

export interface UiHooks {
  /** Pause menu; resolves to continue, or throws Navigate. */
  pauseMenu(): Promise<void>;
  /** Opens the helper settings; resolves when closed. */
  settings(): Promise<void>;
  /** Auto-pause screen after long inactivity. */
  autoPause(): Promise<void>;
  prompt(key: string): Utt;
  onActivity(): void;
}

export interface Timing {
  idleRepeatMs: number;
  autoPauseMs: number;
}

type Outcome = { type: 'select'; index: number } | { type: 'pause' } | { type: 'settings' } | { type: 'autopause' };

export class Ui {
  readonly grid: Grid;
  private resolve: ((o: Outcome) => void) | null = null;
  private spec: AskSpec | null = null;
  private lastTouch = Date.now();
  private lastSpeechEnd = Date.now();
  private idleTimer = 0;
  private flashEl: HTMLElement;
  slots = 3;
  hooks!: UiHooks;

  constructor(
    root: HTMLElement,
    readonly player: Player,
    readonly timing: Timing,
  ) {
    this.grid = new Grid(root, {
      tap: (i) => this.onTap(i),
      select: (i) => this.done({ type: 'select', index: i }),
      menuTap: () => this.onMenuTap(),
      menuHold: () => {
        if (this.spec?.noPause) this.onMenuTap();
        else this.done({ type: 'pause' });
      },
      menuLongHold: () => this.done({ type: 'settings' }),
      touch: () => this.onTouch(),
    });
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'flash';
    this.flashEl.setAttribute('aria-hidden', 'true');
    root.appendChild(this.flashEl);
  }

  /** Shows options and waits for a selection. Returns the selected option index. */
  async ask(spec: AskSpec): Promise<number> {
    let first = true;
    for (;;) {
      const slotsAtStart = this.slots;
      const o = await this.askOnce(spec, first && !!spec.silentStart);
      first = false;
      if (o.type === 'select') return o.index;
      this.player.stop();
      if (o.type === 'pause') await this.hooks.pauseMenu();
      else if (o.type === 'autopause') await this.hooks.autoPause();
      else if (o.type === 'settings') {
        await this.hooks.settings();
        if (this.slots !== slotsAtStart) throw new Navigate({ name: 'main' });
      }
    }
  }

  private askOnce(spec: AskSpec, silent: boolean): Promise<Outcome> {
    this.spec = spec;
    this.grid.render(
      spec.options.map((o, i) => (o ? { text: o.text, color: o.color ?? ZONE_COLORS[i % ZONE_COLORS.length], empty: o.empty } : { text: '', color: '#000', empty: true })),
      this.slots,
    );
    this.grid.resetFocus();
    return new Promise<Outcome>((resolve) => {
      this.resolve = resolve;
      this.lastTouch = Date.now();
      if (!silent) this.speak(spec.prompt, spec.rate);
      else this.lastSpeechEnd = Date.now();
      this.armIdle();
    });
  }

  private done(o: Outcome): void {
    if (!this.resolve) return;
    const r = this.resolve;
    this.resolve = null;
    clearInterval(this.idleTimer);
    this.player.stop();
    r(o);
  }

  private async speak(utts: Utt[], rate?: number): Promise<void> {
    const finished = await this.player.play(utts, { rate });
    if (finished) this.lastSpeechEnd = Date.now();
  }

  private onTap(i: number): void {
    const o = this.spec?.options[i];
    if (!this.resolve) return;
    this.player.stop();
    if (!o || o.empty) void this.speak([this.hooks.prompt('empty_zone')]);
    else void this.speak(o.say);
  }

  private onMenuTap(): void {
    if (!this.resolve || !this.spec) return;
    this.player.stop();
    void this.speak(this.spec.prompt, this.spec.rate);
  }

  private onTouch(): void {
    this.lastTouch = Date.now();
    this.player.unlock();
    sfx.unlock();
    this.hooks?.onActivity();
  }

  private armIdle(): void {
    clearInterval(this.idleTimer);
    if (this.spec?.noIdle) return;
    this.idleTimer = window.setInterval(() => {
      if (!this.resolve || !this.spec) return;
      const now = Date.now();
      if (now - this.lastTouch >= this.timing.autoPauseMs) {
        this.done({ type: 'autopause' });
        return;
      }
      if (!this.player.busy && now - Math.max(this.lastTouch, this.lastSpeechEnd) >= this.timing.idleRepeatMs) {
        this.lastSpeechEnd = now;
        void this.speak(this.spec.prompt, this.spec.rate);
      }
    }, 500);
  }

  /** Speaks without waiting for input (taps are ignored meanwhile). */
  async say(utts: Utt[], rate?: number): Promise<void> {
    await this.player.play(utts, { rate });
    this.lastSpeechEnd = Date.now();
  }

  /** Full-screen colour flash for answer feedback. */
  flash(kind: 'ok' | 'bad'): void {
    const el = this.flashEl;
    el.className = `flash ${kind}`;
    el.textContent = kind === 'ok' ? '✓' : '✗';
    void el.offsetWidth;
    el.classList.add('show');
    window.setTimeout(() => el.classList.remove('show'), 1100);
  }
}
