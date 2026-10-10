// The owner's case: while a word is being spoken, tap the menu zone.
import { launch } from './harness.mjs';

const done = { v: 1, created: Date.now(), words: {}, lessons: {}, days: [], recent: [], tutorialDone: true, answers: 0 };
const h = await launch({ progress: done });
await h.waitQuiet(1200, 40000);
await h.hold(0); await h.waitQuiet(1200, 40000); // continue -> lesson intro
await h.hold(0); // intro: Дальше -> first word starts speaking
await h.page.waitForTimeout(2500);
const t = h.now();
await h.tap(3);
await h.page.waitForTimeout(3500);
console.log('after menu tap:', h.log.filter((e) => e.t > t && e.type === 'play').map((e) => e.text).join(' · '));
await h.page.screenshot({ path: '/tmp/claude-0/busy.png' });
await h.browser.close();
