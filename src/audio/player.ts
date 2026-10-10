// Plays sequences of pre-generated audio clips (public/audio/<id>.ogg).

import type { Utt } from '../types';

export interface Player {
  /** Plays all clips of the utterances in order. Resolves true if finished, false if interrupted. */
  play(utts: Utt[], opts?: { rate?: number }): Promise<boolean>;
  stop(): void;
  readonly busy: boolean;
  /** Called from a user gesture to unlock audio on mobile browsers. */
  unlock(): void;
}

// Clips carry their own leading and trailing silence.
const GAP_MS = 0;
/**
 * Clips start with 350 ms of silence so that the audio output has time to wake up. Within
 * a sequence the output is already running, so later clips skip most of that silence.
 */
const SKIP_LEAD_S = 0.28;
/** A clip that has not ended after this long is considered stuck and skipped. */
const WATCHDOG_MS = 20000;

export function clipUrl(id: string): string {
  return `audio/${id}.ogg`;
}

export class AudioPlayer implements Player {
  private el = new Audio();
  private token = 0;
  private _busy = false;
  /** Finishes the clip that is currently playing (set while a clip plays). */
  private cancelCurrent: (() => void) | null = null;
  private unlocked = false;
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
    if (this.unlocked || this._busy) return;
    // Playing a silent source inside a gesture unlocks the element on mobile browsers.
    this.el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    this.el
      .play()
      .then(() => {
        this.unlocked = true;
      })
      .catch(() => undefined);
  }

  stop(): void {
    this.token++;
    this._busy = false;
    const c = this.cancelCurrent;
    this.cancelCurrent = null;
    c?.();
    this.el.pause();
  }

  async play(utts: Utt[], opts: { rate?: number } = {}): Promise<boolean> {
    this.stop();
    const my = this.token;
    this._busy = true;
    const clips = utts.flatMap((u) => u.c);
    const rate = (opts.rate ?? 1) * this.rate;
    for (let i = 0; i < clips.length; i++) {
      if (my !== this.token) return false;
      await this.playOne(clips[i], rate, i > 0);
      if (my !== this.token) return false;
      if (i < clips.length - 1) await sleep(GAP_MS);
    }
    if (my !== this.token) return false;
    this._busy = false;
    return true;
  }

  private playOne(id: string, rate: number, skipLead = false): Promise<void> {
    const el = this.el;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener('ended', finish);
        el.removeEventListener('error', finish);
        el.removeEventListener('pause', onPause);
        clearTimeout(watchdog);
        if (this.cancelCurrent === finish) this.cancelCurrent = null;
        resolve();
      };
      // Any pause we did not ask for (audio focus loss, headphones unplugged, a call)
      // ends the clip instead of hanging forever. Ignore the pause fired when the source
      // is swapped before playback started.
      let started = false;
      const onPause = () => {
        if (started && !el.ended) finish();
      };
      const watchdog = setTimeout(finish, WATCHDOG_MS);
      el.addEventListener('ended', finish);
      el.addEventListener('error', finish);
      el.addEventListener('pause', onPause);
      this.cancelCurrent = finish;
      // Loading a new source resets playbackRate to defaultPlaybackRate, so set both.
      el.defaultPlaybackRate = rate;
      // A media fragment starts playback after the leading silence.
      el.src = clipUrl(id) + (skipLead ? `#t=${SKIP_LEAD_S}` : '');
      el.playbackRate = rate;
      el.play().then(
        () => {
          started = true;
          this.unlocked = true;
        },
        () => finish(),
      );
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
