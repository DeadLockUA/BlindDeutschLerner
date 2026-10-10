// Random touches, holds, back presses and screen-off/on with real audio. Reports errors
// and periods where the app neither talks nor shows zones (possible freezes).
import { launch } from './harness.mjs';

const seconds = Number(process.argv[2] ?? 180);
const progress = { v: 1, created: Date.now(), words: {}, lessons: {}, days: [], recent: [], tutorialDone: process.argv[3] !== 'fresh', answers: 0 };
const h = await launch({ progress });
await h.page.waitForTimeout(2000);
const end = Date.now() + seconds * 1000;
let actions = 0;
let lastProgress = { t: h.now(), n: h.log.length };
let freezes = 0;
const rnd = (n) => Math.floor(Math.random() * n);
while (Date.now() < end) {
  if (await h.page.locator('.overlay.open').count()) {
    await h.page.goBack(); // close settings
    await h.page.waitForTimeout(500);
    continue;
  }
  const n = await h.page.locator('.zone').count();
  const r = Math.random();
  try {
    if (n === 0) await h.page.waitForTimeout(500);
    else if (r < 0.35) await h.tap(rnd(n));
    else if (r < 0.75) await h.hold(rnd(n - 1), 2300);
    else if (r < 0.8) await h.hold(n - 1, 2300); // pause menu
    else if (r < 0.83) await h.page.goBack();
    else if (r < 0.85) {
      await h.page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await h.page.waitForTimeout(1500);
      await h.page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    } else await h.page.waitForTimeout(rnd(3000));
  } catch (e) {
    console.log('action error', String(e).slice(0, 120));
  }
  actions++;
  await h.page.waitForTimeout(200 + rnd(1500));
  // Freeze detector: nothing played for 20 s although the user kept acting.
  if (h.log.length !== lastProgress.n) lastProgress = { t: h.now(), n: h.log.length };
  else if (h.now() - lastProgress.t > 20000) {
    freezes++;
    console.log('POSSIBLE FREEZE at', h.now(), 'zones', await h.zones());
    lastProgress = { t: h.now(), n: h.log.length };
  }
}
const plays = h.log.filter((e) => e.type === 'play').length;
console.log(`actions ${actions}, clips played ${plays}, freezes ${freezes}`);
console.log('zones at end', await h.zones());
console.log('ERRORS:', h.errors.slice(0, 20));
await h.browser.close();
