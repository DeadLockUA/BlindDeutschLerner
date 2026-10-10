import { expect, test } from '@playwright/test';
import { clearSpoken, doneTutorial, hold, holdText, openApp, spoken, tap, waitSpoken, zoneTexts } from './helpers';

test('first launch runs the spoken tutorial, then starts the first lesson', async ({ page }) => {
  await openApp(page);
  await waitSpoken(page, 'Добро пожаловать');
  await waitSpoken(page, 'Удерживайте верхнюю левую часть');
  // Wrong zone first: the tutorial asks again.
  await expect(page.locator('.zone')).toHaveCount(4);
  await hold(page, 1);
  await hold(page, 0);
  await waitSpoken(page, 'Вы умеете выбирать');
  await waitSpoken(page, 'Здравствуйте и до свидания');
  const texts = await zoneTexts(page);
  expect(texts[0]).toContain('Дальше');
  expect(texts[3]).toContain('Меню');
});

test('tap speaks a zone, hold selects it', async ({ page }) => {
  await openApp(page, { progress: doneTutorial });
  await waitSpoken(page, 'Главное меню');
  await clearSpoken(page);
  await tap(page, 0);
  await waitSpoken(page, 'Продолжить обучение');
  // Basic mode: three items per page, the third zone pages through the rest.
  await holdText(page, 'Ещё');
  await waitSpoken(page, 'Другие пункты меню');
  await holdText(page, 'Мой прогресс');
  await waitSpoken(page, 'Вы ещё не начали обучение');
});

test('a full word group: intro, drills with feedback flash', async ({ page }) => {
  await openApp(page, { progress: doneTutorial });
  await waitSpoken(page, 'Главное меню');
  await holdText(page, 'Продолжить обучение');
  await waitSpoken(page, 'Начинаем урок');
  await holdText(page, 'Дальше');
  await waitSpoken(page, 'Новые слова');
  // Introduce 4 words.
  for (let k = 0; k < 4; k++) {
    await page.waitForTimeout(150);
    await holdText(page, 'Дальше');
  }
  await waitSpoken(page, 'Что это значит?');
  // Answer the first question by picking the first zone (may be right or wrong).
  await page.waitForTimeout(150);
  await hold(page, 0);
  await expect(page.locator('.flash.show')).toBeVisible();
  const s = await spoken(page);
  expect(s.some((x) => /Правильно|Верно|Отлично|Молодец|Неправильно/.test(x))).toBeTruthy();
});

test('menu zone hold opens pause menu; main menu returns', async ({ page }) => {
  await openApp(page, { progress: doneTutorial });
  await waitSpoken(page, 'Главное меню');
  await holdText(page, 'Выбрать урок');
  await waitSpoken(page, 'Выберите модуль');
  await hold(page, 3);
  await waitSpoken(page, 'Пауза');
  expect((await zoneTexts(page))[2]).toContain('Главное меню');
  await clearSpoken(page);
  await hold(page, 2);
  await waitSpoken(page, 'Главное меню');
});

test('pro mode shows six zones', async ({ page }) => {
  await openApp(page, { progress: doneTutorial, settings: { pro: true } });
  await waitSpoken(page, 'Главное меню');
  await expect(page.locator('.zone')).toHaveCount(6);
  expect((await zoneTexts(page))[5]).toContain('Меню');
});

test('long hold on menu opens helper settings', async ({ page }) => {
  await openApp(page, { progress: doneTutorial });
  await waitSpoken(page, 'Главное меню');
  await hold(page, 3, 5300);
  await expect(page.getByRole('dialog', { name: 'Настройки для помощника' })).toBeVisible();
  await page.getByRole('button', { name: 'Профессионал: 6 частей экрана' }).click();
  await page.getByRole('button', { name: 'Закрыть настройки' }).first().click();
  await expect(page.locator('.zone')).toHaveCount(6);
});

test('key link saves the assistant key and hides it', async ({ page }) => {
  await page.goto('./?test#key=sk-or-v1-test123');
  await page.locator('.gate').click();
  await waitSpoken(page, 'Ключ ассистента сохранён');
  expect(page.url()).not.toContain('sk-or');
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('bdl.settings') ?? '{}'));
  expect(s.apiKey).toBe('sk-or-v1-test123');
});
