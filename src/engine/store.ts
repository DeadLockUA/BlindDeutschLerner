// Settings and learning progress, stored only on the device (localStorage).

export type DeVoice = 'both' | 'm' | 'f';

export interface Settings {
  pro: boolean;
  holdMs: number;
  rate: number;
  deVoice: DeVoice;
  apiKey: string;
  /** Preferred OpenRouter model id; empty = automatic. */
  model: string;
}

export interface WordState {
  /** Leitner box 0..6. */
  b: number;
  /** Due date as day number (days since epoch, local time). */
  due: number;
  ok: number;
  bad: number;
}

export interface LessonState {
  done: boolean;
  /** Best score in percent. */
  best?: number;
  at?: number;
}

export interface Progress {
  v: 1;
  created: number;
  words: Record<string, WordState>;
  lessons: Record<string, LessonState>;
  /** Lesson in progress and the step to resume from. */
  current?: { lessonId: string; step: number; ok?: number; n?: number };
  /** Days (YYYY-MM-DD) with any study. */
  days: string[];
  /** Results of recent answers (1 = correct), newest last, max 60. */
  recent: number[];
  tutorialDone: boolean;
  lastBackup?: number;
  lastBackupRemind?: number;
  proOffered?: number;
  /** Total answers given. */
  answers: number;
}

const SETTINGS_KEY = 'bdl.settings';
const PROGRESS_KEY = 'bdl.progress';

export const defaultSettings = (): Settings => ({
  pro: false,
  holdMs: 2000,
  rate: 1,
  deVoice: 'both',
  apiKey: '',
  model: '',
});

export const emptyProgress = (): Progress => ({
  v: 1,
  created: Date.now(),
  words: {},
  lessons: {},
  days: [],
  recent: [],
  tutorialDone: false,
  answers: 0,
});

function read<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable */
  }
}

export function loadSettings(): Settings {
  return { ...defaultSettings(), ...(read<Partial<Settings>>(SETTINGS_KEY) ?? {}) };
}

export function saveSettings(s: Settings): void {
  write(SETTINGS_KEY, s);
}

export function loadProgress(): Progress {
  const p = read<Progress>(PROGRESS_KEY);
  if (!p || p.v !== 1) return emptyProgress();
  return { ...emptyProgress(), ...p };
}

export function saveProgress(p: Progress): void {
  write(PROGRESS_KEY, p);
}

export function today(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Local day number (days since 1970-01-01 in local time). */
export function dayNumber(d = new Date()): number {
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
}

export function markStudyDay(p: Progress, d = new Date()): void {
  const t = today(d);
  if (p.days[p.days.length - 1] !== t) p.days.push(t);
  if (p.days.length > 400) p.days.splice(0, p.days.length - 400);
}

/** Number of consecutive study days ending today (or yesterday). */
export function streak(p: Progress, now = new Date()): number {
  const set = new Set(p.days);
  const d = new Date(now);
  if (!set.has(today(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (set.has(today(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function recordAnswer(p: Progress, correct: boolean): void {
  p.recent.push(correct ? 1 : 0);
  if (p.recent.length > 60) p.recent.splice(0, p.recent.length - 60);
  p.answers++;
}

export function accuracy(p: Progress, last = 40): number | null {
  const r = p.recent.slice(-last);
  if (r.length < 10) return null;
  return r.reduce((a, b) => a + b, 0) / r.length;
}

// ---- Backup -------------------------------------------------------------------

export interface Backup {
  app: 'nemetskiy-na-slukh';
  savedAt: string;
  progress: Progress;
  settings: Omit<Settings, 'apiKey'>;
}

export function makeBackup(p: Progress, s: Settings): Backup {
  const { apiKey: _omit, ...rest } = s;
  void _omit;
  return { app: 'nemetskiy-na-slukh', savedAt: new Date().toISOString(), progress: p, settings: rest };
}

export function parseBackup(text: string): Backup {
  const b = JSON.parse(text) as Backup;
  if (b?.app !== 'nemetskiy-na-slukh' || !b.progress || b.progress.v !== 1) throw new Error('not a backup file');
  return b;
}
