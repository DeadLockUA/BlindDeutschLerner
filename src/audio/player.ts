// Plays sequences of pre-generated audio clips (public/audio/<id>.ogg).

import type { Utt } from '../types';

export interface Player {
  /** Plays all clips of the utterances in order. Resolves true if finished, false if interrupted. */
  play(utts: Utt[], opts?: { rate?: number }): Promise<boolean>;
  stop(): void;
  readonly busy: boolean;
  /** Called once from a user gesture to unlock audio on mobile browsers. */
  unlock(): void;
}

const GAP_MS = 140;

export function clipUrl(id: string): string {
  return `audio/${id}.ogg`;
}

export class AudioPlayer implements Player {
  private el = new Audio();
  private token = 0;
  private _busy = false;
  rate = 1;

  constructor() {
    this.el.preload = 'auto';
    // Keep pitch natural when slowing down.
    (this.el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
  }

  get busy(): boolean {
    return this._busy;
  }

  unlock(): void {
    // Playing a silent, empty source inside a gesture unlocks the element on Android.
    if (this.el.src) return;
    this.el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    this.el.play().catch(() => undefined);
  }

  stop(): void {
    this.token++;
    this.el.pause();
    this._busy = false;
  }

  async play(utts: Utt[], opts: { rate?: number } = {}): Promise<boolean> {
    const my = ++this.token;
    this._busy = true;
    const clips = utts.flatMap((u) => u.c);
    const rate = (opts.rate ?? 1) * this.rate;
    try {
      for (let i = 0; i < clips.length; i++) {
        if (my !== this.token) return false;
        await this.playOne(clips[i], rate, my);
        if (my !== this.token) return false;
        await sleep(GAP_MS);
      }
      return my === this.token;
    } finally {
      if (my === this.token) this._busy = false;
    }
  }

  private playOne(id: string, rate: number, my: number): Promise<void> {
    return new Promise((resolve) => {
      const el = this.el;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.onended = el.onerror = el.onpause = null;
        clearInterval(watch);
        resolve();
      };
      // Resolve when interrupted by stop() (token change pauses the element).
      const watch = setInterval(() => {
        if (my !== this.token) finish();
      }, 50);
      el.onended = finish;
      el.onerror = finish;
      el.onpause = () => {
        if (my !== this.token) finish();
      };
      el.src = clipUrl(id);
      el.playbackRate = rate;
      el.play().catch(() => finish());
    });
  }
}

/** Test double: records spoken text and finishes quickly. */
export class FakePlayer implements Player {
  spoken: string[] = [];
  private token = 0;
  private _busy = false;
  constructor(private msPerClip = 5) {}
  get busy(): boolean {
    return this._busy;
  }
  unlock(): void {}
  stop(): void {
    this.token++;
    this._busy = false;
  }
  async play(utts: Utt[]): Promise<boolean> {
    const my = ++this.token;
    this._busy = true;
    for (const u of utts) {
      this.spoken.push(u.t);
      await sleep(this.msPerClip * Math.max(1, u.c.length));
      if (my !== this.token) return false;
    }
    this._busy = false;
    return true;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
