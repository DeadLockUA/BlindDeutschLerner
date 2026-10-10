// Interrupting speech with taps, then answering: the app must not freeze.
import { launch } from './harness.mjs';

const done = { v: 1, created: Date.now(), words: {}, lessons: {}, days: [], recent: [], tutorialDone: true, answers: 0 };
const h = await launch({ progress: done });
const q = (ms = 1200) => h.waitQuiet(ms, 40000);
await q();
await h.hold(0); await q(); // Продолжить обучение -> lesson intro
await h.hold(0); await q(); // intro: Дальше
for (let k = 0; k < 4; k++) {
  await h.hold(0); // words: Дальше, interrupting the word speech
  await h.page.waitForTimeout(400);
}
await h.page.waitForTimeout(1500);
console.log('zones (expect quiz):', await h.zones());
let failures = 0;
for (let r = 0; r < 6; r++) {
  await h.page.waitForTimeout(500);
  await h.tap(1);
  await h.page.waitForTimeout(300);
  await h.tap(2);
  await h.page.waitForTimeout(200);
  const before = await h.zones();
  await h.hold(0);
  const t = h.now();
  await h.page.waitForTimeout(9000);
  const after = await h.zones();
  const spoke = h.log.filter((e) => e.t > t && e.type === 'play').map((e) => e.text);
  const ok = spoke.some((x) => /Что это значит|Как сказать|правильный перевод/i.test(x));
  if (!ok) failures++;
  console.log(`round ${r}: ${ok ? 'OK' : 'STUCK?'} ${before.join('/')} -> ${after.join('/')} | ${spoke.slice(0, 6).join(' · ')}`);
}
const t2 = h.now();
await h.hold(3, 2300);
await h.page.waitForTimeout(2500);
console.log('pause:', h.log.filter((e) => e.t > t2 && e.type === 'play').map((e) => e.text).join(' · '), '| zones', await h.zones());
await h.hold(3, 5400);
await h.page.waitForTimeout(800);
console.log('settings open:', await h.page.locator('.overlay.open').count());
await h.page.goBack();
await h.page.waitForTimeout(800);
console.log('settings after back:', await h.page.locator('.overlay.open').count(), '| zones', await h.zones());
console.log('failures', failures, 'ERRORS:', h.errors);
await h.browser.close();
