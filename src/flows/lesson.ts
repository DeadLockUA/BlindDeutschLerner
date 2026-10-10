// Lesson runner, review session and "continue learning".

import type { App } from '../app';
import { dueWords, LEARNED_BOX } from '../engine/srs';
import { accuracy } from '../engine/store';
import { canListen } from '../engine/speech';
import type { Dialogue, Grammar, Lesson, Utt, Word } from '../types';
import { Navigate, type Option } from '../ui/ui';
import { contentChoice, deVoice, drill, newSession, pick, shuffle, speakItem, type DrillKind, type Pool, type Session } from './exercises';

type Step = (s: Session) => Promise<void>;

function pad(app: App, options: (Option | null)[]): (Option | null)[] {
  const o = [...options];
  while (o.length < app.slots) o.push(null);
  return o.slice(0, app.slots);
}

/** Speaks `prompt`, then waits for "next"; "repeat" replays it (slower each time). */
async function listenStep(app: App, prompt: Utt[], opts: { translation?: Utt[]; repeatRate?: number } = {}): Promise<void> {
  const options: (Option | null)[] = [app.optKey('z_next'), app.optKey('z_repeat')];
  if (opts.translation) options.push(app.optKey('z_translation'));
  if (app.slots === 5) options.push(app.optKey('z_slow'));
  let rate = 1;
  let shown = prompt;
  for (;;) {
    const i = await app.ask({ prompt: shown, options: pad(app, options), rate });
    const o = options[i];
    if (i === 0) return;
    if (o?.text === app.P('z_repeat').t) {
      rate = opts.repeatRate ?? 0.85;
      shown = prompt;
    } else if (o?.text === app.P('z_translation').t && opts.translation) {
      rate = 1;
      shown = opts.translation;
    } else if (o?.text === app.P('z_slow').t) {
      rate = 0.7;
      shown = prompt;
    }
  }
}

/** Introduces one word. Returns true if the learner proved he already knows it. */
async function introduceWord(app: App, s: Session, w: Word, pool: Pool): Promise<boolean> {
  const prompt: Utt[] = [...deVoice(app, w, true), w.ru];
  if (w.plural) prompt.push(app.P('plural_is'), w.plural);
  if (w.ex && w.exRu) prompt.push(app.P('example'), w.ex, w.exRu);
  const options: (Option | null)[] = [app.optKey('z_next'), app.optKey('z_repeat'), app.optKey('z_know')];
  if (app.slots === 5) options.push(app.optKey('z_slow'));
  let rate = 1;
  for (;;) {
    const i = await app.ask({ prompt, options: pad(app, options), rate });
    if (i === 0) return false;
    if (i === 1) rate = 0.85;
    if (i === 3) rate = 0.7;
    if (i === 2) {
      await app.say(app.P('know_check'));
      return drill(app, s, w, 'recog', pool, { known: true });
    }
  }
}

/** Drills a group of words: recognition, reverse, yes/no; repeats mistakes once. */
async function drillGroup(app: App, s: Session, words: Word[], pool: Pool): Promise<void> {
  if (!words.length) return;
  const wrong = new Set<Word>();
  const plan: [Word, DrillKind][] = [
    ...shuffle(words).map((w) => [w, 'recog'] as [Word, DrillKind]),
    ...shuffle(words).map((w) => [w, 'reverse'] as [Word, DrillKind]),
    ...shuffle(words)
      .slice(0, Math.ceil(words.length / 2))
      .map((w) => [w, 'yesno'] as [Word, DrillKind]),
  ];
  for (const [w, k] of plan) if (!(await drill(app, s, w, k, pool))) wrong.add(w);
  for (const w of shuffle([...wrong])) await drill(app, s, w, pick(['recog', 'reverse'] as DrillKind[]), pool);
}

function wordSteps(app: App, items: Word[], pool: Pool, headerKey: string): Step[] {
  const steps: Step[] = [];
  const size = 4;
  for (let g = 0; g < items.length; g += size) {
    const group = items.slice(g, g + size);
    const known = new Set<string>();
    steps.push(async (s) => {
      if (g === 0) await app.say(app.P(headerKey));
      for (const w of group) if (await introduceWord(app, s, w, pool)) known.add(w.id);
      await drillGroup(
        app,
        s,
        group.filter((w) => !known.has(w.id)),
        pool,
      );
    });
  }
  return steps;
}

function grammarSteps(app: App, g: Grammar): Step[] {
  return [
    async () => {
      await app.say(app.P('grammar_intro'), g.title);
      for (const p of g.explain) await listenStep(app, [p], { repeatRate: 0.85 });
    },
    async (s) => {
      await app.say(app.P('grammar_practice'));
      for (const q of shuffle(g.exercises)) await contentChoice(app, s, q);
    },
  ];
}

function dialogueLines(d: Dialogue, withTranslation: boolean): Utt[] {
  return d.lines.flatMap((l) => (withTranslation ? [l.de, l.ru] : [l.de]));
}

function dialogueSteps(app: App, d: Dialogue, exam: boolean): Step[] {
  return [
    async (s) => {
      await app.say(exam ? d.title : app.P('dialogue_intro'));
      if (!exam) await app.say(d.title);
      await listenStep(app, dialogueLines(d, false), { translation: exam ? undefined : dialogueLines(d, true), repeatRate: 0.9 });
      if (d.questions.length > 1) await app.say(app.P('dialogue_questions'));
      for (const q of d.questions) await contentChoice(app, s, q);
    },
  ];
}

function speakSteps(app: App, l: Lesson): Step[] {
  const items = [...shuffle(l.words).slice(0, 2), ...shuffle(l.phrases).slice(0, 2)];
  if (!items.length) return [];
  return [
    async () => {
      if (!canListen()) {
        await app.say(app.P('speak_unavailable'));
        return;
      }
      await app.say(app.P('speak_intro'));
      for (const w of items) {
        const r = await speakItem(app, w);
        if (r === 'unavailable') {
          await app.say(app.P('speak_unavailable'));
          return;
        }
      }
    },
  ];
}

export function buildSteps(app: App, l: Lesson, exam: boolean): Step[] {
  // Wrong options come from this lesson first, then from words already studied.
  const lessonItems = [...l.words, ...l.phrases];
  const studied = app.course.loadedWords().filter((w) => app.progress.words[w.id]);
  const pool: Pool = [lessonItems, studied, app.course.loadedWords()];
  const steps: Step[] = [
    async () => {
      await listenStep(app, [app.P('lesson_start'), l.title, ...(l.intro ? [l.intro] : [])]);
    },
    ...wordSteps(app, l.words, pool, 'new_words'),
    ...wordSteps(app, l.phrases, pool, 'new_phrases'),
    ...(l.grammar ? grammarSteps(app, l.grammar) : []),
    ...l.dialogues.flatMap((d) => dialogueSteps(app, d, exam)),
    ...(exam ? [] : speakSteps(app, l)),
  ];
  return steps;
}

/** Makes sure the module's audio is available offline (downloads if needed). */
export async function ensureDownloaded(app: App, moduleId: string): Promise<boolean> {
  if (app.course.isDownloaded(moduleId)) return true;
  if (!navigator.onLine) {
    // Offline after a course update: the audio is usually still in the cache.
    if (await app.course.isCached(moduleId)) return true;
    await app.say(app.P('load_failed'));
    return false;
  }
  void app.say(app.P('loading'));
  // Remind every 10 seconds that the download is still running.
  const reminder = window.setInterval(() => {
    if (!app.player.busy) void app.player.play([app.P('loading_more')]);
  }, 10000);
  let missing = 1;
  try {
    missing = await app.course.downloadShare(moduleId);
  } finally {
    clearInterval(reminder);
    app.player.stop();
  }
  // A few failed clips are fine online: they are fetched when played.
  if (missing > 0.05) {
    await app.say(app.P('load_failed'));
    return false;
  }
  // Prefetch the next module in the background.
  const mods = app.course.index.modules;
  const next = mods[mods.findIndex((m) => m.id === moduleId) + 1];
  if (next && !app.course.isDownloaded(next.id)) void app.course.download(next.id);
  return true;
}

export async function runLesson(app: App, id: string): Promise<'done' | 'aborted'> {
  const moduleId = app.course.moduleOf(id);
  if (!(await ensureDownloaded(app, moduleId))) return 'aborted';
  const mod = await app.course.module(moduleId);
  const l = await app.course.lesson(id);
  app.currentLesson = id;
  const steps = buildSteps(app, l, !!mod.exam);
  const p = app.progress;
  const version = app.course.index.version;
  // Switching lessons keeps the unfinished one's place so it can be resumed later.
  if (p.current && p.current.lessonId !== id) {
    p.paused = { ...(p.paused ?? {}), [p.current.lessonId]: p.current };
    p.current = p.paused[id];
  }
  if (p.paused?.[id]) {
    p.current = p.current ?? p.paused[id];
    delete p.paused[id];
  }
  // Restart the lesson if it was started with different content (step numbers changed).
  if (!p.current || p.current.lessonId !== id || p.current.version !== version || p.current.step > steps.length) p.current = { lessonId: id, step: 0, version };
  const s: Session = newSession();
  const saved = p.current as { lessonId: string; step: number; ok?: number; n?: number };
  s.ok = saved.ok ?? 0;
  s.n = saved.n ?? 0;
  for (let k = saved.step; k < steps.length; k++) {
    await steps[k](s);
    p.current = { lessonId: id, step: k + 1, ok: s.ok, n: s.n, version };
    app.save();
  }
  // Summary
  const pct = s.n ? Math.round((s.ok / s.n) * 100) : 100;
  const prev = p.lessons[id];
  p.lessons[id] = { done: true, best: Math.max(prev?.best ?? 0, pct), at: Date.now() };
  p.current = undefined;
  app.studied();
  await app.say(app.P('lesson_done'), ...(s.n ? [app.P('score'), ...app.num(s.ok), app.P('of'), ...app.num(s.n)] : []));
  await maybeOfferPro(app);
  return 'done';
}

async function maybeOfferPro(app: App): Promise<void> {
  const p = app.progress;
  const acc = accuracy(p, 40);
  if (app.settings.pro || acc === null || acc < 0.9 || p.recent.length < 40) return;
  if (p.proOffered && Date.now() - p.proOffered < 7 * 86400000) return;
  p.proOffered = Date.now();
  app.save();
  const options: (Option | null)[] = [app.optKey('yes'), app.optKey('no')];
  while (options.length < app.slots) options.push(null);
  const i = await app.ask({ prompt: [app.P('pro_offer')], options });
  if (i === 0) {
    app.settings.pro = true;
    app.saveSettings();
    await app.say(app.P('pro_on'));
    throw new Navigate({ name: 'main' });
  }
  await app.say(app.P('pro_off'));
}

/** Review of due words (spaced repetition). */
export async function runReview(app: App, opts: { standalone: boolean }): Promise<void> {
  const p = app.progress;
  let ids = dueWords(p, app.today, 12);
  if (!ids.length && opts.standalone) {
    ids = shuffle(Object.entries(p.words).filter(([, st]) => st.b >= LEARNED_BOX).map(([id]) => id)).slice(0, 8);
  }
  if (!ids.length) {
    if (opts.standalone) await app.say(app.P(p.answers ? 'review_nothing' : 'prog_none'));
    return;
  }
  // Load the modules that contain these words (from their lesson history).
  const words = await app.course.words(ids);
  if (!words.length) return;
  for (const mid of new Set(words.map((w) => app.course.moduleOf(app.course.lessonOfWord(w.id) ?? 'm01')))) {
    if (!app.course.isDownloaded(mid)) await ensureDownloaded(app, mid);
  }
  await app.say(app.P('review_intro'));
  const s = newSession();
  const studied = app.course.loadedWords().filter((w) => app.progress.words[w.id]);
  const pool: Pool = [studied, app.course.loadedWords()];
  for (const w of words) await drill(app, s, w, pick(['recog', 'reverse', 'yesno'] as DrillKind[]), pool);
  await app.say(app.P('review_done'));
}

/** "Continue learning": review due words, then resume or start the next lesson. */
export async function runContinue(app: App): Promise<void> {
  const p = app.progress;
  if (!p.current) await runReview(app, { standalone: false });
  for (;;) {
    const next = p.current?.lessonId ?? app.course.lessonIds.find((id) => !p.lessons[id]?.done);
    if (!next) {
      await app.say(app.P('course_done'), app.P('all_done_review'));
      await runReview(app, { standalone: true });
      return;
    }
    if (!p.current) {
      const sum = app.course.lessonSummary(next);
      if (sum) await app.say(app.P('next_lesson'), sum.module.title, app.P('lesson'), ...app.num(sum.number), sum.lesson.title);
    }
    const r = await runLesson(app, next);
    if (r === 'aborted') return;
    const options: (Option | null)[] = [app.optKey('z_next'), app.optKey('p_main')];
    while (options.length < app.slots) options.push(null);
    const i = await app.ask({ prompt: [app.P('next_lesson_offer')], options });
    if (i !== 0) return;
  }
}
