import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { doneTutorial, hold, openApp, waitSpoken } from './helpers';

test('helper instructions page has no accessibility violations', async ({ page }) => {
  await page.goto('./help.html');
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test('settings screen has no accessibility violations', async ({ page }) => {
  await openApp(page, { progress: doneTutorial });
  await waitSpoken(page, 'Главное меню');
  await hold(page, 3, 5300);
  await expect(page.getByRole('dialog')).toBeVisible();
  const r = await new AxeBuilder({ page }).include('.overlay').analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test('zone grid has labelled buttons and good contrast', async ({ page }) => {
  await openApp(page, { progress: doneTutorial });
  await waitSpoken(page, 'Главное меню');
  const r = await new AxeBuilder({ page }).include('.grid').analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
