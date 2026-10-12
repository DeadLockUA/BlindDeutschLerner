#!/usr/bin/env node
// Validates the course sources in content/ and compiles them into public/course/*.json
// plus an audio manifest (public/course/audio-manifest.json) listing every clip that the
// audio generator (scripts/gen_audio.py) must produce.
//
// Usage: node scripts/build-content.mjs [--strict]
//   --strict  fail if any audio clip is missing in public/audio

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTENT = join(ROOT, 'content');
const OUT = join(ROOT, 'public', 'course');
const AUDIO = join(ROOT, 'public', 'audio');
const strict = process.argv.includes('--strict');

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);

/** voice -> text -> id */
const manifest = new Map();

// Each voice may set an "id" in scripts/voices.json; changing it (e.g. when switching the
// model) gives all clips of that voice new ids, so they get regenerated.
const VOICES = JSON.parse(readFileSync(join(ROOT, 'scripts', 'voices.json'), 'utf8'));
const voiceHashId = (voice) => VOICES[voice]?.id ?? voice;

export function clipId(voice, text) {
  return createHash('sha1').update(`${voice}|${text}`).digest('hex').slice(0, 12);
}

/** Text as sent to the TTS engine. */
function ttsText(text) {
  let t = text.replace(/\s+/g, ' ').trim();
  // Piper speaks isolated words more naturally with final punctuation.
  if (!/[.!?…]$/.test(t)) t += '.';
  return t;
}

const QUESTION_WORDS = new Set(
  ('что чем чего чему как какой какая какое какие каким какого какую каком где куда откуда когда ' +
    'почему зачем кто кого кому сколько чей чья чьё чьи который которая которое которые ли').split(' '),
);

/**
 * A Russian yes/no question: a sentence ending in "?" without a question word
 * («Это правильный перевод?»). Only intonation makes it a question, which ESpeech
 * renders flat, so these clips use the "ru-q" voice.
 */
function isYesNoQuestion(text) {
  const sentences = text.match(/[^.!?…]*\?/g) ?? [];
  return sentences.some((s) => !s.toLowerCase().split(/[^а-яё]+/).some((w) => QUESTION_WORDS.has(w)));
}

function clip(voice, text) {
  const tts = ttsText(text);
  if (voice === 'ru' && VOICES['ru-q'] && isYesNoQuestion(tts)) voice = 'ru-q';
  const id = clipId(voiceHashId(voice), tts);
  manifest.set(id, { id, voice, text: tts });
  return id;
}

const MARK = /\[\[(.+?)\]\]/g;

/**
 * Compiles a text with optional [[German]] markup into an utterance.
 * `base` is the voice for unmarked text: 'ru', 'de-m' or 'de-f'.
 * `deVoice` is the voice used for [[...]] parts inside Russian text.
 */
function utt(text, where, base = 'ru', deVoice = 'de-m') {
  if (typeof text !== 'string' || !text.trim()) {
    err(where, `expected non-empty text, got ${JSON.stringify(text)}`);
    return { t: '', c: [] };
  }
  const display = text.replace(MARK, '$1').replace(/\s+/g, ' ').trim();
  const c = [];
  let last = 0;
  for (const m of text.matchAll(MARK)) {
    const before = text.slice(last, m.index);
    if (/[\p{L}\p{N}]/u.test(before)) c.push(clip(base, before));
    c.push(clip(deVoice, m[1]));
    last = m.index + m[0].length;
  }
  const rest = text.slice(last);
  if (/[\p{L}\p{N}]/u.test(rest)) c.push(clip(base, rest));
  if (/\[\[|\]\]/.test(text.replace(MARK, ''))) err(where, `unbalanced [[ ]] in ${JSON.stringify(text)}`);
  if (base === 'ru' && /[a-zäöüß]{3,}/i.test(text.replace(MARK, '')) && !/OpenRouter|Google|Goethe|Chrome|Android/.test(text)) {
    warnings.push(`${where}: Latin text outside [[ ]] in Russian: ${JSON.stringify(text)}`);
  }
  if (base !== 'ru' && /[а-яё]/i.test(text)) err(where, `Cyrillic in German text: ${JSON.stringify(text)}`);
  return { t: display, c };
}

const wordKey = (de) =>
  de
    .toLowerCase()
    .replace(/[.!?,;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const seenWords = new Map(); // key -> lesson id

function compileWord(w, where, kind) {
  if (!w || typeof w !== 'object') {
    err(where, 'word must be an object');
    return null;
  }
  for (const k of Object.keys(w)) {
    if (!['de', 'ru', 'plural', 'ex', 'exRu'].includes(k)) err(where, `unknown word field "${k}"`);
  }
  if (typeof w.de !== 'string') {
    err(where, 'word.de missing');
    return null;
  }
  if (MARK.test(w.de)) err(where, 'word.de must not contain [[ ]]');
  MARK.lastIndex = 0;
  if ((w.ex && !w.exRu) || (!w.ex && w.exRu)) err(where, 'ex and exRu go together');
  const key = wordKey(w.de);
  const lessonId = where.split('/')[0];
  if (seenWords.has(key)) err(where, `duplicate item "${w.de}" (already in ${seenWords.get(key)})`);
  else seenWords.set(key, where);
  const out = {
    id: key,
    kind,
    de: utt(w.de, `${where}.de`, 'de-m'),
    deF: utt(w.de, `${where}.de`, 'de-f'),
    ru: utt(w.ru, `${where}.ru`, 'ru'),
  };
  if (w.plural) out.plural = utt(w.plural, `${where}.plural`, 'de-m');
  if (w.ex) {
    out.ex = utt(w.ex, `${where}.ex`, 'de-f');
    out.exRu = utt(w.exRu, `${where}.exRu`, 'ru');
  }
  void lessonId;
  return out;
}

function compileChoice(q, where, defaultQ) {
  if (!q || typeof q !== 'object') {
    err(where, 'question must be an object');
    return null;
  }
  for (const k of Object.keys(q)) if (!['q', 'options'].includes(k)) err(where, `unknown question field "${k}"`);
  const opts = q.options;
  if (!Array.isArray(opts) || opts.length < 3 || opts.length > 5) {
    err(where, 'options must be an array of 3..5 items (first is correct)');
    return null;
  }
  const norm = opts.map((o) => String(o).replace(MARK, '$1').trim().toLowerCase());
  if (new Set(norm).size !== norm.length) err(where, 'duplicate options');
  return {
    q: utt(q.q ?? defaultQ, `${where}.q`),
    options: opts.map((o, i) => utt(String(o), `${where}.options[${i}]`)),
  };
}

function compileDialogue(d, where) {
  if (!d || typeof d !== 'object') {
    err(where, 'dialogue must be an object');
    return null;
  }
  for (const k of Object.keys(d)) if (!['title', 'speakers', 'lines', 'questions'].includes(k)) err(where, `unknown dialogue field "${k}"`);
  const speakers = d.speakers ?? {};
  for (const [s, v] of Object.entries(speakers)) if (!['m', 'f'].includes(v)) err(where, `speaker ${s} must be m or f`);
  if (!Array.isArray(d.lines) || d.lines.length < 1) err(where, 'lines required');
  const lines = (d.lines ?? []).map((l, i) => {
    const w = `${where}.lines[${i}]`;
    if (!Array.isArray(l) || l.length !== 3) {
      err(w, 'line must be [speaker, german, russian]');
      return null;
    }
    const [who, de, ru] = l;
    if (!speakers[who]) err(w, `unknown speaker "${who}"`);
    const voice = speakers[who] === 'f' ? 'de-f' : 'de-m';
    return { who, de: utt(de, `${w}.de`, voice), ru: utt(ru, `${w}.ru`, 'ru') };
  });
  if (!Array.isArray(d.questions) || d.questions.length < 1) err(where, 'at least one question required');
  return {
    title: utt(d.title, `${where}.title`),
    lines: lines.filter(Boolean),
    questions: (d.questions ?? []).map((q, i) => compileChoice(q, `${where}.questions[${i}]`, 'Выберите правильный ответ.')).filter(Boolean),
  };
}

function compileLesson(l, where, exam) {
  for (const k of Object.keys(l)) {
    if (!['id', 'title', 'intro', 'words', 'phrases', 'grammar', 'dialogue', 'dialogues'].includes(k)) err(where, `unknown lesson field "${k}"`);
  }
  if (!/^m\d\dl\d\d$/.test(l.id ?? '')) err(where, `bad lesson id ${l.id}`);
  const id = l.id;
  const words = (l.words ?? []).map((w, i) => compileWord(w, `${id}/words[${i}]`, 'word')).filter(Boolean);
  const phrases = (l.phrases ?? []).map((w, i) => compileWord(w, `${id}/phrases[${i}]`, 'phrase')).filter(Boolean);
  if (!exam && words.length < 6) err(id, `too few words (${words.length})`);
  let grammar;
  if (l.grammar) {
    const g = l.grammar;
    for (const k of Object.keys(g)) if (!['title', 'explain', 'exercises'].includes(k)) err(`${id}/grammar`, `unknown grammar field "${k}"`);
    if (!Array.isArray(g.explain) || !g.explain.length) err(`${id}/grammar`, 'explain must be a non-empty list');
    if (!Array.isArray(g.exercises) || g.exercises.length < 3) err(`${id}/grammar`, 'at least 3 exercises');
    grammar = {
      title: utt(g.title, `${id}/grammar.title`),
      explain: (g.explain ?? []).map((p, i) => utt(p, `${id}/grammar.explain[${i}]`)),
      exercises: (g.exercises ?? []).map((q, i) => compileChoice(q, `${id}/grammar.exercises[${i}]`, 'Как правильно?')).filter(Boolean),
    };
  }
  const dl = l.dialogues ?? (l.dialogue ? [l.dialogue] : []);
  if (!dl.length) err(id, 'a dialogue is required');
  return {
    id,
    title: utt(l.title, `${id}.title`),
    ...(l.intro ? { intro: utt(l.intro, `${id}.intro`) } : {}),
    words,
    phrases,
    ...(grammar ? { grammar } : {}),
    dialogues: dl.map((d, i) => compileDialogue(d, `${id}/dialogues[${i}]`)).filter(Boolean),
  };
}

function collectClips(obj, set = new Set()) {
  if (Array.isArray(obj)) obj.forEach((x) => collectClips(x, set));
  else if (obj && typeof obj === 'object') {
    if (Array.isArray(obj.c) && typeof obj.t === 'string') obj.c.forEach((c) => set.add(c));
    else Object.values(obj).forEach((x) => collectClips(x, set));
  }
  return set;
}

function audioBytes(clips) {
  let total = 0;
  for (const c of clips) {
    const f = join(AUDIO, `${c}.ogg`);
    total += existsSync(f) ? statSync(f).size : 6000;
  }
  return total;
}

// ---------------------------------------------------------------------------

const prompts = parse(readFileSync(join(CONTENT, 'prompts.yaml'), 'utf8'));
const compiledPrompts = {};
for (const [k, v] of Object.entries(prompts)) compiledPrompts[k] = utt(String(v), `prompts.${k}`);

const moduleFiles = readdirSync(join(CONTENT, 'modules'))
  .filter((f) => f.endsWith('.yaml'))
  .sort();
const modules = [];
for (const f of moduleFiles) {
  const src = parse(readFileSync(join(CONTENT, 'modules', f), 'utf8'));
  const where = f;
  for (const k of Object.keys(src)) if (!['id', 'title', 'exam', 'lessons'].includes(k)) err(where, `unknown module field "${k}"`);
  if (!/^m\d\d$/.test(src.id ?? '')) err(where, `bad module id ${src.id}`);
  if (`${src.id}.yaml` !== f) err(where, 'file name must match module id');
  const lessons = (src.lessons ?? []).map((l, i) => {
    if (!l.id?.startsWith(src.id)) err(`${where}/lessons[${i}]`, `lesson id ${l.id} must start with ${src.id}`);
    return compileLesson(l, `${where}/lessons[${i}]`, !!src.exam);
  });
  modules.push({ id: src.id, title: utt(src.title, `${where}.title`), ...(src.exam ? { exam: true } : {}), lessons });
}

for (const w of warnings) console.warn('warning:', w);
if (errors.length) {
  for (const e of errors) console.error('error:', e);
  console.error(`\n${errors.length} content error(s).`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const summaries = [];
for (const m of modules) {
  writeFileSync(join(OUT, `${m.id}.json`), JSON.stringify(m));
  const clips = [...collectClips(m)];
  summaries.push({
    id: m.id,
    title: m.title,
    ...(m.exam ? { exam: true } : {}),
    lessons: m.lessons.map((l) => ({ id: l.id, title: l.title })),
    clips,
    bytes: audioBytes(clips),
  });
}
// Lesson titles live in the index too; make them part of core.
const coreClips = [...collectClips(compiledPrompts), ...collectClips(summaries.map((s) => [s.title, s.lessons]))];
const uniqueCore = [...new Set(coreClips)];
const allEntries = [...manifest.values()];
const version = createHash('sha1')
  .update(JSON.stringify(modules) + JSON.stringify(compiledPrompts))
  .digest('hex')
  .slice(0, 10);
const index = {
  version,
  modules: summaries,
  prompts: compiledPrompts,
  coreClips: uniqueCore,
  coreBytes: audioBytes(uniqueCore),
};
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
writeFileSync(join(OUT, 'audio-manifest.json'), JSON.stringify(allEntries));

const missing = allEntries.filter((e) => !existsSync(join(AUDIO, `${e.id}.ogg`)));
const words = modules.reduce((n, m) => n + m.lessons.reduce((k, l) => k + l.words.length, 0), 0);
const phrases = modules.reduce((n, m) => n + m.lessons.reduce((k, l) => k + l.phrases.length, 0), 0);
const lessons = modules.reduce((n, m) => n + m.lessons.length, 0);
console.log(
  `content ok: ${modules.length} modules, ${lessons} lessons, ${words} words, ${phrases} phrases, ${allEntries.length} clips (${missing.length} missing audio)`,
);
if (strict && missing.length) {
  console.error(`missing audio for ${missing.length} clips; run: python scripts/gen_audio.py`);
  process.exit(1);
}
