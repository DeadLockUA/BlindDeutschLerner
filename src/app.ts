// Application core: state, routing between flows, menus.

import type { Player } from './audio/player';
import { Course } from './engine/course';
import { dueCount, learnedCount } from './engine/srs';
import { accuracy, dayNumber, loadProgress, loadSettings, markStudyDay, saveProgress, saveSettings, streak, type Progress, type Settings } from './engine/store';
import { runCommand } from './flows/command';
import { runContinue, runLesson, runReview } from './flows/lesson';
import { runTalk } from './flows/talk';
import { runTutorial } from './flows/tutorial';
import { openSettings } from './ui/settings';
import { Navigate, Ui, type AskSpec, type Option, type Route } from './ui/ui';
import type { Utt } from './types';

export interface AppOptions {
  player: Player;
  root: HTMLElement;
  test: boolean;
  idleRepeatMs: number;
  autoPauseMs: number;
}

export class App {
  course!: Course;
  progress: Progress;
  settings: Settings;
  ui: Ui;
  readonly test: boolean;
  /** The lesson currently being played (for context in commands). */
  currentLesson?: string;

  constructor(readonly opts: AppOptions) {
    this.test = opts.test;
    this.progress = loadProgress();
    this.settings = loadSettings();
    this.ui = new Ui(opts.root, opts.player, { idleRepeatMs: opts.idleRepeatMs, autoPauseMs: opts.autoPauseMs });
    this.applySettings();
    this.ui.hooks = {
      pauseMenu: () => this.pauseMenu(),
      settings: () => this.openSettings(),
      autoPause: () => this.autoPause(),
      prompt: (k) => this.P(k),
      onActivity: () => undefined,
    };
  }

  get player(): Player {
    return this.opts.player;
  }

  applySettings(): void {
    this.ui.slots = this.settings.pro ? 5 : 3;
    this.ui.grid.holdMs = this.test ? Math.min(this.settings.holdMs, 300) : this.settings.holdMs;
    (this.player as { rate?: number }).rate = this.settings.rate;
  }

  saveSettings(): void {
    saveSettings(this.settings);
    this.applySettings();
  }

  save(): void {
    saveProgress(this.progress);
  }

  studied(): void {
    markStudyDay(this.progress);
    this.save();
  }

  get today(): number {
    return dayNumber();
  }

  // ---- Speech helpers -------------------------------------------------------------

  /** A Russian UI phrase by key. */
  P(key: string): Utt {
    const u = this.course?.index.prompts[key];
    if (!u) {
      console.warn('missing prompt', key);
      return { t: key, c: [] };
    }
    return u;
  }

  /** Speaks a number in Russian (0..1999). */
  num(n: number): Utt[] {
    n = Math.max(0, Math.round(n));
    const out: Utt[] = [];
    if (n >= 1000) {
      out.push(this.P('n1000'));
      n -= 1000;
      if (n === 0) return out;
    }
    if (n >= 100) {
      out.push(this.P(`n${Math.floor(n / 100) * 100}`));
      n %= 100;
      if (n === 0) return out;
    }
    out.push(this.P(`n${n}`));
    return out;
  }

  say(...utts: Utt[]): Promise<void> {
    return this.ui.say(utts);
  }

  /** Builds an option that shows `text` and speaks `say` (default: the text's own utterance). */
  opt(u: Utt, say?: Utt[], color?: string): Option {
    return { text: u.t, say: say ?? [u], color };
  }

  optKey(key: string, color?: string): Option {
    return this.opt(this.P(key), undefined, color);
  }

  ask(spec: AskSpec): Promise<number> {
    return this.ui.ask(spec);
  }

  get slots(): number {
    return this.ui.slots;
  }

  /**
   * A menu that may have more items than zones: the last zone becomes "more".
   * Returns the index of the chosen item.
   */
  async menu(prompt: Utt[], items: Option[], opts: { back?: boolean } = {}): Promise<number> {
    const all = opts.back ? [...items, this.optKey('m_back')] : items;
    const slots = this.slots;
    const perPage = all.length <= slots ? slots : slots - 1;
    let page = 0;
    const pages = Math.ceil(all.length / perPage);
    for (;;) {
      const pageItems = all.slice(page * perPage, page * perPage + perPage);
      const opts2: (Option | null)[] = [...pageItems];
      if (pages > 1) {
        while (opts2.length < slots - 1) opts2.push(null);
        opts2.push({ text: this.P('m_more').t, say: [this.P('m_more_hint')], color: '#9aa0a6' });
      }
      const i = await this.ask({ prompt: page === 0 ? prompt : [this.P('m_more_hint')], options: opts2 });
      if (pages > 1 && i === slots - 1) {
        page = (page + 1) % pages;
        continue;
      }
      const idx = page * perPage + i;
      if (opts.back && idx === all.length - 1) throw new Navigate({ name: 'main' });
      return idx;
    }
  }

  // ---- Pause, auto-pause, settings -------------------------------------------------

  private pausing = false;

  async pauseMenu(): Promise<void> {
    if (this.pausing) return;
    this.pausing = true;
    try {
      const items = [this.optKey('p_resume'), this.optKey('m_command'), this.optKey('p_main')];
      const options: (Option | null)[] = [...items];
      while (options.length < this.slots) options.push(null);
      const i = await this.ask({ prompt: [this.P('pause_menu'), this.P('menu_hint')], options, noPause: true, noIdle: true });
      if (i === 1) await runCommand(this, { fromPause: true });
      if (i === 2) throw new Navigate({ name: 'main' });
    } finally {
      this.pausing = false;
    }
  }

  async autoPause(): Promise<void> {
    this.save();
    const options: (Option | null)[] = [this.optKey('p_resume')];
    while (options.length < this.slots) options.push(null);
    await this.ask({ prompt: [this.P('auto_pause')], options, noPause: true, noIdle: true });
  }

  async openSettings(): Promise<void> {
    this.player.stop();
    await this.say(this.P('settings_open'));
    await openSettings(this);
  }

  // ---- Routing --------------------------------------------------------------------

  async run(): Promise<void> {
    let route: Route = { name: 'start' };
    for (;;) {
      try {
        route = await this.route(route);
      } catch (e) {
        if (e instanceof Navigate) route = e.route;
        else {
          console.error(e);
          route = { name: 'main' };
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  }

  private async route(r: Route): Promise<Route> {
    this.currentLesson = undefined;
    switch (r.name) {
      case 'start':
        return this.start();
      case 'main':
        return this.mainMenu();
      case 'continue':
        await runContinue(this);
        return { name: 'main' };
      case 'lesson':
        await runLesson(this, r.id);
        return { name: 'main' };
      case 'review':
        await runReview(this, { standalone: true });
        return { name: 'main' };
      case 'choose':
        return this.chooseLesson();
      case 'progress':
        await this.speakProgress();
        return { name: 'main' };
      case 'command':
        await runCommand(this, { fromPause: false });
        return { name: 'main' };
      case 'talk':
        await runTalk(this);
        return { name: 'main' };
      case 'tutorial':
        await runTutorial(this);
        return { name: 'main' };
    }
  }

  private async start(): Promise<Route> {
    if (!this.progress.tutorialDone) {
      await this.say(this.P('hello'), this.P('welcome_first'));
      await runTutorial(this);
      this.progress.tutorialDone = true;
      this.save();
      return { name: 'continue' };
    }
    await this.say(this.P('hello'));
    const now = Date.now();
    const week = 7 * 86400000;
    if (this.progress.answers > 0 && now - (this.progress.lastBackup ?? this.progress.created) > week && now - (this.progress.lastBackupRemind ?? 0) > 86400000) {
      this.progress.lastBackupRemind = now;
      this.save();
      await this.say(this.P('backup_remind'));
    }
    return { name: 'main' };
  }

  private async mainMenu(): Promise<Route> {
    const items: { o: Option; r: Route }[] = [
      { o: this.optKey('m_continue'), r: { name: 'continue' } },
      { o: this.optKey('m_choose'), r: { name: 'choose' } },
      { o: this.optKey('m_progress'), r: { name: 'progress' } },
      { o: this.optKey('m_command'), r: { name: 'command' } },
    ];
    if (this.settings.apiKey) items.push({ o: this.optKey('m_talk'), r: { name: 'talk' } });
    items.push({ o: this.optKey('m_tutorial'), r: { name: 'tutorial' } });
    const prompt = [this.P('main_menu')];
    const resume = this.progress.current;
    if (resume || this.progress.answers === 0) prompt.push(this.P('m_continue'));
    prompt.push(this.P('menu_hint'));
    const i = await this.menu(prompt, items.map((x) => x.o));
    return items[i].r;
  }

  private async chooseLesson(): Promise<Route> {
    const mods = this.course.index.modules;
    const mi = await this.menu(
      [this.P('choose_module')],
      mods.map((m, k) => {
        const num = m.exam ? [] : [this.P('module'), ...this.num(k + 1)];
        return { text: `${m.exam ? '' : `${k + 1}. `}${m.title.t}`, say: [...num, m.title] };
      }),
      { back: true },
    );
    const m = mods[mi];
    const li = await this.menu(
      [m.title, this.P('choose_lesson')],
      m.lessons.map((l, k) => {
        const done = this.progress.lessons[l.id]?.done;
        return {
          text: `${k + 1}. ${l.title.t}${done ? ' ✓' : ''}`,
          say: [this.P('lesson'), ...this.num(k + 1), l.title, ...(done ? [this.P('done_mark')] : [])],
        };
      }),
      { back: true },
    );
    return { name: 'lesson', id: m.lessons[li].id };
  }

  /** Spoken progress summary. */
  progressUtts(): Utt[] {
    const p = this.progress;
    if (p.answers === 0) return [this.P('prog_none')];
    const total = this.course.lessonIds.length;
    const done = this.course.lessonIds.filter((id) => p.lessons[id]?.done).length;
    const out: Utt[] = [
      this.P('prog_words'),
      ...this.num(learnedCount(p)),
      this.P('prog_lessons'),
      ...this.num(done),
      this.P('of'),
      ...this.num(total),
      this.P('prog_due'),
      ...this.num(dueCount(p, this.today)),
      this.P('prog_streak'),
      ...this.num(streak(p)),
    ];
    const acc = accuracy(p);
    if (acc !== null) out.push(this.P('prog_accuracy'), ...this.num(Math.round(acc * 100)));
    return out;
  }

  async speakProgress(): Promise<void> {
    const options: (Option | null)[] = [this.optKey('z_repeat'), this.optKey('m_back')];
    for (;;) {
      const i = await this.ask({ prompt: this.progressUtts(), options });
      if (i === 1) return;
    }
  }

  static async create(opts: AppOptions): Promise<App> {
    const app = new App(opts);
    app.course = await Course.load();
    return app;
  }
}
