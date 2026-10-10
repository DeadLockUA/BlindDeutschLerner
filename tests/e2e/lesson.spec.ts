import { expect, test, type Page } from '@playwright/test';
import { doneTutorial, hold, openApp, spoken, waitSpoken, zoneTexts } from './helpers';

/** Plays through whatever is on screen until `doneText` is spoken. */
async function playThrough(page: Page, doneText: string, maxSteps = 400): Promise<number> {
  for (let step = 0; step < maxSteps; step++) {
    const s = await spoken(page);
    if (s.some((x) => x.includes(doneText))) return step;
    const texts = await zoneTexts(page);
    let idx = texts.findIndex((t) => t.includes('Дальше') || t.includes('Пропустить') || t.includes('Продолжить урок'));
    if (idx < 0) idx = Math.floor(Math.random() * (texts.length - 1)); // random answer
    await hold(page, idx);
    await page.waitForTimeout(60);
  }
  throw new Error(`"${doneText}" not reached`);
}

test('a whole lesson can be played from start to summary', async ({ page }) => {
  test.setTimeout(240000);
  await openApp(page, { progress: { ...doneTutorial } });
  await waitSpoken(page, 'Главное меню');
  await hold(page, 0); // Продолжить обучение
  await waitSpoken(page, 'Начинаем урок', 30000);
  await playThrough(page, 'Урок пройден');
  const s = await spoken(page);
  expect(s.some((x) => x.includes('Грамматика'))).toBeTruthy();
  expect(s.some((x) => x.includes('Послушайте диалог'))).toBeTruthy();
  expect(s.some((x) => x.includes('Правильных ответов'))).toBeTruthy();
  const p = await page.evaluate(() => JSON.parse(localStorage.getItem('bdl.progress')!));
  expect(p.lessons.m01l01.done).toBe(true);
  expect(Object.keys(p.words).length).toBeGreaterThan(10);
  // Offered the next lesson.
  await waitSpoken(page, 'Начать следующий урок');
});

test('an exam lesson plays its listening tasks', async ({ page }) => {
  test.setTimeout(180000);
  await openApp(page, { progress: { ...doneTutorial, current: { lessonId: 'm13l01', step: 0 } } });
  await waitSpoken(page, 'Главное меню');
  await hold(page, 0);
  await waitSpoken(page, 'Начинаем урок', 30000);
  await playThrough(page, 'Урок пройден');
  expect((await spoken(page)).some((x) => x.includes('Задание 1'))).toBeTruthy();
});
