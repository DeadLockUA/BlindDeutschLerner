// Speech recognition (Chrome's Web Speech API, needs internet) and system TTS for
// dynamic text (assistant replies).

export type ListenError = 'unsupported' | 'offline' | 'denied' | 'no-speech' | 'error';

export interface ListenResult {
  ok: boolean;
  alternatives: string[];
  error?: ListenError;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function ctor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

export function canListen(): boolean {
  return !!ctor() && navigator.onLine;
}

/** Test hook: queued fake recognition results (used by e2e tests). */
const fakeQueue: ListenResult[] = [];
export function pushFakeListen(r: ListenResult): void {
  fakeQueue.push(r);
}

export function listen(lang: 'de-DE' | 'ru-RU', timeoutMs = 7000): Promise<ListenResult> {
  if (fakeQueue.length) return Promise.resolve(fakeQueue.shift()!);
  const C = ctor();
  if (!C) return Promise.resolve({ ok: false, alternatives: [], error: 'unsupported' });
  if (!navigator.onLine) return Promise.resolve({ ok: false, alternatives: [], error: 'offline' });
  return new Promise((resolve) => {
    const rec = new C();
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 5;
    rec.continuous = false;
    let settled = false;
    const finish = (r: ListenResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const t = setTimeout(() => finish({ ok: false, alternatives: [], error: 'no-speech' }), timeoutMs);
    rec.onresult = (e) => {
      const res = e.results[0];
      const alts: string[] = [];
      for (let i = 0; i < res.length; i++) alts.push(res[i].transcript);
      finish({ ok: alts.length > 0, alternatives: alts });
    };
    rec.onerror = (e) => {
      const map: Record<string, ListenError> = {
        'not-allowed': 'denied',
        'service-not-allowed': 'denied',
        'no-speech': 'no-speech',
        network: 'offline',
        'audio-capture': 'denied',
      };
      finish({ ok: false, alternatives: [], error: map[e.error] ?? 'error' });
    };
    rec.onend = () => finish({ ok: false, alternatives: [], error: 'no-speech' });
    try {
      rec.start();
    } catch {
      finish({ ok: false, alternatives: [], error: 'error' });
    }
  });
}

// ---- Pronunciation check -------------------------------------------------------

const UMLAUT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

export function normalizeGerman(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => UMLAUT[c])
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const NUMBERS: Record<string, string> = {
  '0': 'null', '1': 'eins', '2': 'zwei', '3': 'drei', '4': 'vier', '5': 'fuenf', '6': 'sechs', '7': 'sieben', '8': 'acht', '9': 'neun',
  '10': 'zehn', '11': 'elf', '12': 'zwoelf',
};

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * Lenient comparison of a recognized phrase with the target: case, punctuation and
 * small spelling differences are ignored; articles are optional for single nouns.
 * Returns a score 0..1; >= 0.7 counts as correct.
 */
export function pronunciationScore(target: string, heard: string): number {
  const ARTICLES = new Set(['der', 'die', 'das']);
  let t = normalizeGerman(target);
  const h = normalizeGerman(heard).map((w) => NUMBERS[w] ?? w);
  if (!t.length || !h.length) return 0;
  if (t.length === 2 && ARTICLES.has(t[0]) && h.length === 1) t = t.slice(1);
  let matched = 0;
  const used = new Set<number>();
  for (const tw of t) {
    let best = -1;
    let bestDist = Infinity;
    h.forEach((hw, i) => {
      if (used.has(i)) return;
      const dist = levenshtein(tw, hw);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    if (best >= 0 && bestDist <= Math.max(1, Math.floor(tw.length / 4))) {
      matched++;
      used.add(best);
    }
  }
  const extra = Math.max(0, h.length - t.length);
  return Math.max(0, (matched - extra * 0.5) / t.length);
}

export function pronunciationOk(target: string, alternatives: string[]): boolean {
  return alternatives.some((a) => pronunciationScore(target, a) >= 0.7);
}

// ---- System TTS (assistant replies) ----------------------------------------------

export function canSpeakSystem(): boolean {
  return 'speechSynthesis' in window;
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang.replace('_', '-').toLowerCase().startsWith(lang.toLowerCase().slice(0, 2)) && v.localService) ?? voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)));
}

let ttsToken = 0;

export function stopSystemSpeech(): void {
  ttsToken++;
  if (canSpeakSystem()) speechSynthesis.cancel();
}

/** Speaks segments like [{lang:'ru', text}, {lang:'de', text}] in order. */
export async function speakSystem(segments: { lang: 'ru' | 'de'; text: string }[], rate = 1): Promise<boolean> {
  if (!canSpeakSystem()) return false;
  const my = ++ttsToken;
  speechSynthesis.cancel();
  for (const s of segments) {
    if (my !== ttsToken) return false;
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(s.text);
      u.lang = s.lang === 'de' ? 'de-DE' : 'ru-RU';
      const v = pickVoice(u.lang);
      if (v) u.voice = v;
      u.rate = rate * (s.lang === 'de' ? 0.9 : 1);
      const t = setTimeout(resolve, 2000 + s.text.length * 150);
      u.onend = u.onerror = () => {
        clearTimeout(t);
        resolve();
      };
      speechSynthesis.speak(u);
    });
  }
  return my === ttsToken;
}

/** Splits "Русский текст [[deutscher Text]] ..." into language segments. */
export function splitMarked(text: string): { lang: 'ru' | 'de'; text: string }[] {
  const out: { lang: 'ru' | 'de'; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[\[(.+?)\]\]/g)) {
    const before = text.slice(last, m.index).trim();
    if (before) out.push({ lang: 'ru', text: before });
    out.push({ lang: 'de', text: m[1] });
    last = (m.index ?? 0) + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push({ lang: 'ru', text: rest });
  return out;
}
