// Spaced repetition (Leitner boxes).

import type { Progress, WordState } from './store';

/** Interval in days for each box. */
export const INTERVALS = [0, 1, 3, 7, 16, 35, 90];
export const MAX_BOX = INTERVALS.length - 1;
/** A word counts as "learned" from this box on. */
export const LEARNED_BOX = 2;

export function newState(today: number): WordState {
  return { b: 0, due: today, ok: 0, bad: 0 };
}

/**
 * Updates a word after an answer.
 * `firstTime` — the very first answer about this word; a correct first answer means the
 * learner already knew it, so it jumps ahead (fast pass for known words).
 */
export function grade(p: Progress, id: string, correct: boolean, today: number, opts: { firstTime?: boolean; known?: boolean } = {}): WordState {
  const s = p.words[id] ?? newState(today);
  if (correct) {
    s.ok++;
    if (opts.known) s.b = Math.max(s.b, 3);
    else if (opts.firstTime && s.ok === 1 && s.bad === 0) s.b = Math.max(s.b, LEARNED_BOX);
    else s.b = Math.min(MAX_BOX, s.b + 1);
  } else {
    s.bad++;
    // A mistake sends the word back to the start: it comes up again in the next review.
    s.b = 0;
  }
  s.due = today + INTERVALS[s.b];
  p.words[id] = s;
  return s;
}

/** Words due for review, most overdue / weakest first. */
export function dueWords(p: Progress, today: number, limit = 12): string[] {
  return Object.entries(p.words)
    .filter(([, s]) => s.due <= today && (s.ok > 0 || s.bad > 0))
    .sort((a, b) => a[1].due - b[1].due || a[1].b - b[1].b)
    .slice(0, limit)
    .map(([id]) => id);
}

export function learnedCount(p: Progress): number {
  return Object.values(p.words).filter((s) => s.b >= LEARNED_BOX).length;
}

export function dueCount(p: Progress, today: number): number {
  return Object.values(p.words).filter((s) => s.due <= today && (s.ok > 0 || s.bad > 0)).length;
}

/** Words with the most mistakes. */
export function weakWords(p: Progress, limit = 15): string[] {
  return Object.entries(p.words)
    .filter(([, s]) => s.bad > 0)
    .sort((a, b) => b[1].bad - b[1].ok / 2 - (a[1].bad - a[1].ok / 2))
    .slice(0, limit)
    .map(([id]) => id);
}
