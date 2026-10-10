// Short synthesized sound effects and vibration patterns.

let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.25, when = 0, slideTo?: number): void {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + when;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}

export const sfx = {
  unlock(): void {
    ac();
  },
  correct(): void {
    tone(660, 0.12, 'sine', 0.3);
    tone(990, 0.22, 'sine', 0.3, 0.11);
    vibrate(60);
  },
  wrong(): void {
    tone(220, 0.35, 'square', 0.12, 0, 150);
    vibrate([180, 80, 180]);
  },
  select(): void {
    tone(880, 0.08, 'triangle', 0.3);
    vibrate(140);
  },
  /** Signals "start speaking now" before speech recognition. */
  listen(): void {
    tone(740, 0.15, 'sine', 0.3);
  },
  tick(): void {
    vibrate(12);
  },
};

/** Rising tone played while a zone is held. */
export class HoldTone {
  private o: OscillatorNode | null = null;
  private g: GainNode | null = null;

  start(durationMs: number): void {
    const a = ac();
    if (!a) return;
    this.stop();
    const t0 = a.currentTime;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(300, t0);
    o.frequency.exponentialRampToValueAtTime(900, t0 + durationMs / 1000);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.1);
    o.connect(g).connect(a.destination);
    o.start(t0);
    this.o = o;
    this.g = g;
  }

  stop(): void {
    const a = ctx;
    if (this.o && this.g && a) {
      const t = a.currentTime;
      this.g.gain.cancelScheduledValues(t);
      this.g.gain.setValueAtTime(this.g.gain.value, t);
      this.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      this.o.stop(t + 0.06);
    }
    this.o = null;
    this.g = null;
  }
}
