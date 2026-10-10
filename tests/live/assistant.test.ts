import { describe, expect, it } from 'vitest';
import { askAssistant, talkSystemPrompt, talkTurn, type AssistantContext } from '../../src/engine/llm';

const KEY = process.env.OPENROUTER_API_KEY || 'injected-by-proxy';

const ctx: AssistantContext = {
  lessons: [
    { id: 'm01l01', title: 'Знакомство: Здравствуйте и до свидания', done: true },
    { id: 'm03l01', title: 'Семья и друзья: Моя семья', done: false },
    { id: 'm04l05', title: 'Еда и напитки: В кафе', done: false },
  ],
  currentLesson: 'm01l01',
  learnedWords: 20,
  weakWords: ['die Nacht (ночь)'],
  dueWords: 3,
};

describe('assistant with real free models', () => {
  it('answers a language question in Russian with German in [[ ]]', async () => {
    const r = await askAssistant(KEY, '', 'Как по-немецки будет «спасибо»?', ctx);
    console.log('reply:', r);
    expect(r.say).toMatch(/[а-я]/i);
    expect(r.say).toMatch(/\[\[.*dank.*\]\]/i);
  });

  it('maps a navigation request to a whitelisted command', async () => {
    const r = await askAssistant(KEY, '', 'Открой, пожалуйста, урок про семью', ctx);
    console.log('reply:', r);
    expect(r.command).toEqual({ type: 'open_lesson', lesson: 'm03l01' });
  });

  it('runs a conversation turn in German', async () => {
    const t = await talkTurn(KEY, '', [
      { role: 'system', content: talkSystemPrompt('В кафе', ['der Kaffee', 'das Wasser', 'bestellen']) },
      { role: 'user', content: 'Начни разговор: поздоровайся и задай первый простой вопрос по теме.' },
    ]);
    console.log('turn:', t);
    expect(t.de).toMatch(/[a-zäöüß]/i);
    expect(t.ru).toMatch(/[а-я]/i);
  });
});
