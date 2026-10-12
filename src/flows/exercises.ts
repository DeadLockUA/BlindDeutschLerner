// Exercise building blocks: multiple choice, word drills, pronunciation.

import type { App } from '../app';
import { sfx } from '../audio/sfx';
import { grade } from '../engine/srs';
import { recordAnswer } from '../engine/store';
import { listen, pronunciationOk, canListen } from '../engine/speech';
import type { Choice, Utt, Word } from '../types';
import { Navigate, type Option } from '../ui/ui';

export function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export function pick<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}

/** Session statistics of the running lesson / review. */
export interface Session {
  ok: number;
  n: number;
  wrongStreak: number;
}

export function newSession(): Session {
  return { ok: 0, n: 0, wrongStreak: 0 };
}

/** German utterance(s) of a word according to the voice setting. */
export function deVoice(app: App, w: Word, both = false): Utt[] {
  const v = app.settings.deVoice;
  if (v === 'm') return [w.de];
  if (v === 'f') return [w.deF];
  return both ? [w.de, w.deF] : [Math.random() < 0.5 ? w.de : w.deF];
}

async function feedback(app: App, correct: boolean, right: Utt[]): Promise<void> {
  if (correct) {
    app.ui.flash('ok');
    sfx.correct();
    await app.say(app.P(pick(['ok_1', 'ok_2', 'ok_3', 'ok_4'])));
  } else {
    app.ui.flash('bad');
    sfx.wrong();
    await app.say(app.P('wrong'), app.P('right_answer'), ...right);
  }
}

/** Offers a break after several mistakes in a row. */
async function checkFatigue(app: App, s: Session): Promise<void> {
  if (s.wrongStreak < 4) return;
  s.wrongStreak = 0;
  const options: (Option | null)[] = [app.optKey('z_break'), app.optKey('z_go_on')];
  while (options.length < app.slots) options.push(null);
  const i = await app.ask({ prompt: [app.P('break_offer')], options });
  if (i === 0) {
    app.save();
    await app.say(app.P('break_ok'));
    throw new Navigate({ name: 'main' });
  }
}

/**
 * Generic multiple choice. `correct` + up to (slots-1) of `wrongs` are shown shuffled.
 * Returns whether the answer was correct.
 */
export async function choice(app: App, s: Session, prompt: Utt[], correct: Option, wrongs: Option[], right?: Utt[]): Promise<boolean> {
  const n = Math.min(app.slots, wrongs.length + 1);
  const opts = shuffle([correct, ...shuffle(wrongs).slice(0, n - 1)]);
  const options: (Option | null)[] = [...opts];
  while (options.length < app.slots) options.push(null);
  const i = await app.ask({ prompt, options });
  const ok = options[i] === correct;
  s.n++;
  if (ok) {
    s.ok++;
    s.wrongStreak = 0;
  } else s.wrongStreak++;
  recordAnswer(app.progress, ok);
  app.studied();
  await feedback(app, ok, right ?? correct.say);
  await checkFatigue(app, s);
  return ok;
}

/** A question from the content (first option correct). */
export function contentChoice(app: App, s: Session, q: Choice, extraPrompt: Utt[] = []): Promise<boolean> {
  const [first, ...rest] = q.options.map((o) => app.opt(o));
  return choice(app, s, [...extraPrompt, q.q], first, rest);
}

/** Distractor candidates in order of preference (e.g. current lesson, known words, rest). */
export type Pool = Word[] | Word[][];

/** Picks distractor words for `w` (same kind and earlier tiers preferred, distinct meaning). */
export function distractors(w: Word, pool: Pool, n: number): Word[] {
  const tiers: Word[][] = Array.isArray(pool[0]) ? (pool as Word[][]) : [pool as Word[]];
  const ok = (x: Word) => x.id !== w.id && x.ru.t.toLowerCase() !== w.ru.t.toLowerCase() && x.de.t.toLowerCase() !== w.de.t.toLowerCase();
  const ordered: Word[] = [];
  for (const tier of tiers) ordered.push(...shuffle(tier.filter((x) => ok(x) && x.kind === w.kind)));
  for (const tier of tiers) ordered.push(...shuffle(tier.filter((x) => ok(x) && x.kind !== w.kind)));
  const out: Word[] = [];
  const seenRu = new Set<string>();
  for (const x of ordered) {
    if (out.length >= n) break;
    const key = x.ru.t.toLowerCase();
    if (seenRu.has(key)) continue;
    seenRu.add(key);
    out.push(x);
  }
  return out;
}

export type DrillKind = 'recog' | 'reverse' | 'yesno';

/** One word exercise; updates spaced repetition. */
export async function drill(app: App, s: Session, w: Word, kind: DrillKind, pool: Pool, opts: { known?: boolean } = {}): Promise<boolean> {
  const firstTime = !app.progress.words[w.id];
  const others = distractors(w, pool, 4);
  let ok: boolean;
  if (kind === 'recog' || others.length < 2) {
    ok = await choice(
      app,
      s,
      [app.P('ex_recog'), ...deVoice(app, w)],
      app.opt(w.ru),
      others.map((x) => app.opt(x.ru)),
      [...deVoice(app, w), app.P('means'), w.ru],
    );
  } else if (kind === 'reverse') {
    const de = (x: Word) => ({ text: x.de.t, say: deVoice(app, x) });
    ok = await choice(app, s, [app.P('ex_reverse'), w.ru], de(w), others.map(de), [w.ru, app.P('means'), w.de]);
  } else {
    const truthful = Math.random() < 0.5;
    const shown = truthful ? w : others[0];
    const [yes, no] = app.yesNo();
    const correct = truthful ? yes : no;
    const prompt = [...deVoice(app, w), app.P('means'), shown.ru, app.P('ex_yesno')];
    const options: (Option | null)[] = [yes, no];
    while (options.length < app.slots) options.push(null);
    const i = await app.ask({ prompt, options });
    ok = options[i] === correct;
    s.n++;
    if (ok) {
      s.ok++;
      s.wrongStreak = 0;
    } else s.wrongStreak++;
    recordAnswer(app.progress, ok);
    await feedback(app, ok, [w.de, app.P('means'), w.ru]);
    await checkFatigue(app, s);
  }
  grade(app.progress, w.id, ok, app.today, { firstTime, known: opts.known && ok });
  app.studied();
  return ok;
}

/** Pronunciation practice for one item. Returns true if pronounced acceptably. */
export async function speakItem(app: App, w: Word): Promise<'ok' | 'fail' | 'skip' | 'unavailable'> {
  if (!canListen()) return 'unavailable';
  let attempts = 0;
  const options: (Option | null)[] = [app.optKey('z_speak'), app.optKey('z_listen'), app.optKey('z_skip')];
  while (options.length < app.slots) options.push(null);
  let prompt: Utt[] = [app.P('speak_repeat'), w.de];
  for (;;) {
    const i = await app.ask({ prompt, options });
    if (i === 1) {
      await app.say(w.de, app.P('z_slow'));
      await app.ui.say([w.de], 0.75);
      prompt = [w.de];
      continue;
    }
    if (i === 2) return 'skip';
    sfx.listen();
    const r = await listen('de-DE');
    if (!r.ok) {
      if (r.error === 'denied') {
        await app.say(app.P('mic_error'));
        return 'unavailable';
      }
      if (r.error === 'offline' || r.error === 'unsupported') return 'unavailable';
      await app.say(app.P('no_speech'));
      prompt = [w.de];
      continue;
    }
    attempts++;
    if (pronunciationOk(w.de.t, r.alternatives)) {
      app.ui.flash('ok');
      sfx.correct();
      await app.say(app.P('speak_good'));
      return 'ok';
    }
    if (attempts >= 2) {
      app.ui.flash('bad');
      await app.say(app.P('speak_listen'), w.de, w.deF);
      return 'fail';
    }
    sfx.wrong();
    await app.say(app.P('speak_try_again'));
    prompt = [w.de];
  }
}
