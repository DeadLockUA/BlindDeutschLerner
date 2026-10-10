import { describe, expect, it } from 'vitest';
import { dueWords, grade, learnedCount, LEARNED_BOX, weakWords } from '../../src/engine/srs';
import { emptyProgress, makeBackup, markStudyDay, parseBackup, recordAnswer, accuracy, streak, defaultSettings } from '../../src/engine/store';
import { pronunciationOk, pronunciationScore, splitMarked } from '../../src/engine/speech';
import { parseJson, validateCommand } from '../../src/engine/llm';
import { parseLocalCommand } from '../../src/flows/command';
import { distractors } from '../../src/flows/exercises';
import type { Word } from '../../src/types';

describe('spaced repetition', () => {
  it('a correct first answer marks the word as learned (fast pass)', () => {
    const p = emptyProgress();
    const s = grade(p, 'hallo', true, 100, { firstTime: true });
    expect(s.b).toBe(LEARNED_BOX);
    expect(s.due).toBe(103);
    expect(learnedCount(p)).toBe(1);
  });

  it('"I know this word" + correct check jumps further', () => {
    const p = emptyProgress();
    expect(grade(p, 'x', true, 0, { firstTime: true, known: true }).b).toBe(3);
  });

  it('a mistake resets the box and makes the word due', () => {
    const p = emptyProgress();
    grade(p, 'a', true, 0, { firstTime: true });
    grade(p, 'a', true, 3);
    const s = grade(p, 'a', false, 10);
    expect(s.b).toBe(0);
    expect(dueWords(p, 10)).toEqual(['a']);
    expect(weakWords(p)).toEqual(['a']);
  });

  it('dueWords orders by due date and respects the limit', () => {
    const p = emptyProgress();
    p.words = { a: { b: 1, due: 5, ok: 1, bad: 0 }, b: { b: 1, due: 2, ok: 1, bad: 0 }, c: { b: 1, due: 50, ok: 1, bad: 0 } };
    expect(dueWords(p, 10)).toEqual(['b', 'a']);
    expect(dueWords(p, 10, 1)).toEqual(['b']);
  });
});

describe('progress store', () => {
  it('counts a streak of consecutive days', () => {
    const p = emptyProgress();
    const d = new Date(2026, 9, 10);
    for (const k of [3, 2, 1, 0]) {
      const x = new Date(d);
      x.setDate(x.getDate() - k);
      markStudyDay(p, x);
    }
    expect(streak(p, d)).toBe(4);
    const later = new Date(d);
    later.setDate(later.getDate() + 2);
    expect(streak(p, later)).toBe(0);
  });

  it('accuracy needs at least 10 answers', () => {
    const p = emptyProgress();
    for (let i = 0; i < 9; i++) recordAnswer(p, true);
    expect(accuracy(p)).toBeNull();
    recordAnswer(p, false);
    expect(accuracy(p)).toBeCloseTo(0.9);
  });

  it('backups never contain the API key and round-trip', () => {
    const p = emptyProgress();
    p.lessons.m01l01 = { done: true, best: 90 };
    const b = makeBackup(p, { ...defaultSettings(), apiKey: 'secret' });
    const text = JSON.stringify(b);
    expect(text).not.toContain('secret');
    expect(parseBackup(text).progress.lessons.m01l01.done).toBe(true);
    expect(() => parseBackup('{"foo":1}')).toThrow();
  });
});

describe('pronunciation check', () => {
  it('accepts exact and near matches, ignoring case and punctuation', () => {
    expect(pronunciationOk('Guten Morgen!', ['guten morgen'])).toBe(true);
    expect(pronunciationOk('der Schlüssel', ['Schlüssel'])).toBe(true);
    expect(pronunciationOk('der Schlüssel', ['der Schlussel'])).toBe(true);
    expect(pronunciationOk('Wie geht es Ihnen?', ['wie geht es ihnen'])).toBe(true);
    expect(pronunciationOk('zwölf', ['12'])).toBe(true);
  });

  it('rejects different words', () => {
    expect(pronunciationOk('die Küche', ['der Kuchen ist gut'])).toBe(false);
    expect(pronunciationOk('Auf Wiedersehen!', ['guten Tag'])).toBe(false);
    expect(pronunciationScore('Danke', '')).toBe(0);
  });
});

describe('marked text', () => {
  it('splits Russian and German segments', () => {
    expect(splitMarked('Слово [[der Tisch]] значит стол.')).toEqual([
      { lang: 'ru', text: 'Слово' },
      { lang: 'de', text: 'der Tisch' },
      { lang: 'ru', text: 'значит стол.' },
    ]);
  });
});

describe('assistant', () => {
  it('extracts JSON from noisy replies', () => {
    expect(parseJson<{ say: string }>('Вот: ```json\n{"say": "Привет {друг}", "command": null}\n```')?.say).toBe('Привет {друг}');
    expect(parseJson('нет json')).toBeNull();
  });

  it('only whitelisted commands with existing lessons pass', () => {
    const ids = ['m01l01', 'm01l02'];
    expect(validateCommand({ type: 'open_lesson', lesson: 'm01l02' }, ids)).toEqual({ type: 'open_lesson', lesson: 'm01l02' });
    expect(validateCommand({ type: 'open_lesson', lesson: 'm99l01' }, ids)).toBeNull();
    expect(validateCommand({ type: 'delete_everything' }, ids)).toBeNull();
    expect(validateCommand({ type: 'review' }, ids)).toEqual({ type: 'review' });
    expect(validateCommand(null, ids)).toBeNull();
  });
});

describe('voice commands', () => {
  const ids = ['m02l03'];
  it('parses common Russian commands', () => {
    expect(parseLocalCommand('дальше', ids)).toEqual({ kind: 'resume' });
    expect(parseLocalCommand('Главное меню', ids)).toEqual({ kind: 'route', route: { name: 'main' } });
    expect(parseLocalCommand('модуль 2 урок 3', ids)).toEqual({ kind: 'route', route: { name: 'lesson', id: 'm02l03' } });
    expect(parseLocalCommand('давай повторим слова', ids)).toEqual({ kind: 'route', route: { name: 'review' } });
    expect(parseLocalCommand('мой прогресс', ids)).toEqual({ kind: 'progress' });
    expect(parseLocalCommand('почему здесь den', ids)).toBeNull();
  });
});

describe('distractors', () => {
  const w = (id: string, ru: string, kind: 'word' | 'phrase' = 'word'): Word => ({
    id,
    kind,
    de: { t: id, c: [] },
    deF: { t: id, c: [] },
    ru: { t: ru, c: [] },
  });
  it('never includes the word itself or the same translation', () => {
    const target = w('der hund', 'собака');
    const pool = [target, w('die katze', 'кошка'), w('der köter', 'собака'), w('das haus', 'дом'), w('guten tag', 'добрый день', 'phrase')];
    const d = distractors(target, pool, 4);
    expect(d.map((x) => x.id)).not.toContain('der hund');
    expect(d.map((x) => x.ru.t)).not.toContain('собака');
    expect(d[0].kind).toBe('word');
  });
});
