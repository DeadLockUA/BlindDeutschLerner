import type { Page } from '@playwright/test';

export const HOLD = 300;

export async function openApp(page: Page, opts: { query?: string; progress?: unknown; settings?: unknown } = {}): Promise<void> {
  await page.addInitScript(
    ([progress, settings]) => {
      if (progress) localStorage.setItem('bdl.progress', JSON.stringify(progress));
      if (settings) localStorage.setItem('bdl.settings', JSON.stringify(settings));
    },
    [opts.progress ?? null, opts.settings ?? null],
  );
  await page.goto(`./?test&${opts.query ?? 'idle=600000&autopause=600000'}`);
  await page.locator('.gate').click();
}

export function spoken(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __player: { spoken: string[] } }).__player.spoken);
}

export async function clearSpoken(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __player: { spoken: string[] } }).__player.spoken.length = 0;
  });
}

/** Waits until something containing `text` has been spoken. */
export async function waitSpoken(page: Page, text: string, timeout = 10000): Promise<void> {
  await page.waitForFunction(
    (t) => (window as unknown as { __player: { spoken: string[] } }).__player.spoken.some((s) => s.includes(t)),
    text,
    { timeout },
  );
}

async function center(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(`.zone[data-index="${index}"]`).boundingBox();
  if (!box) throw new Error(`zone ${index} not visible`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function hold(page: Page, index: number, ms = HOLD + 150): Promise<void> {
  const c = await center(page, index);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

export async function tap(page: Page, index: number): Promise<void> {
  const c = await center(page, index);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();
}

/** Selects the zone whose label contains `text`. */
export async function holdText(page: Page, text: string): Promise<void> {
  const zones = page.locator('.zone');
  const n = await zones.count();
  for (let i = 0; i < n; i++) {
    if ((await zones.nth(i).innerText()).includes(text)) return hold(page, i);
  }
  throw new Error(`no zone with text "${text}"; zones: ${(await zones.allInnerTexts()).join(' | ')}`);
}

export async function zoneTexts(page: Page): Promise<string[]> {
  return page.locator('.zone').allInnerTexts();
}

export const doneTutorial = { v: 1, created: Date.now(), words: {}, lessons: {}, days: [], recent: [], tutorialDone: true, answers: 0 };
