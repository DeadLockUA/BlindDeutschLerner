// Real-device-like harness: real AudioPlayer, mobile touch emulation, audio event trace.
import { chromium, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

const manifest = new Map(JSON.parse(readFileSync(new URL('../../public/course/audio-manifest.json', import.meta.url))).map((e) => [e.id, e]));
const BASE = process.env.BASE ?? 'http://localhost:4175/';

export async function launch({ progress, settings, query = '' } = {}) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const log = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  await page.exposeFunction('__ev', (type, src) => {
    const id = (src.match(/audio\/([0-9a-f]+)\.ogg/) ?? [])[1];
    const e = id ? manifest.get(id) : null;
    log.push({ t: Date.now() - t0, type, text: e ? e.text : src.slice(0, 40) });
  });
  await page.addInitScript(([progress, settings]) => {
    if (progress) localStorage.setItem('bdl.progress', JSON.stringify(progress));
    if (settings) localStorage.setItem('bdl.settings', JSON.stringify(settings));
    const P = HTMLMediaElement.prototype;
    const play = P.play;
    const hooked = new WeakSet();
    P.play = function () {
      if (!hooked.has(this)) {
        hooked.add(this);
        for (const ev of ['ended', 'pause', 'error']) this.addEventListener(ev, () => window.__ev(ev, this.src || ''));
      }
      window.__ev('play', this.src);
      return play.call(this);
    };
  }, [progress ?? null, settings ?? null]);
  const cdp = await ctx.newCDPSession(page);
  await page.goto(BASE + query);
  const zoneCenter = async (i) => {
    const b = await page.locator(`.zone[data-index="${i}"]`).boundingBox();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  };
  const touch = async (i, ms) => {
    const p = await zoneCenter(i);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    await page.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  return {
    page, log, errors, browser,
    tap: (i) => touch(i, 80),
    hold: (i, ms = 2300) => touch(i, ms),
    zones: () => page.locator('.zone').allInnerTexts(),
    /** Prints the speech timeline since `from` (ms). Marks clips cut off by others. */
    print(from = 0) {
      const out = [];
      for (let k = 0; k < log.length; k++) {
        const e = log[k];
        if (e.t < from || e.type !== 'play') continue;
        const end = log.slice(k + 1).find((x) => x.text === e.text && (x.type === 'ended' || x.type === 'pause' || x.type === 'error'));
        out.push(`${String(e.t).padStart(6)} ${end ? (end.type === 'ended' ? '   ' : end.type.toUpperCase().slice(0, 3)) : '...'} ${e.text}`);
      }
      return out.join('\n');
    },
    now: () => Date.now() - t0,
    waitQuiet: async (ms = 1500, max = 60000) => {
      const start = Date.now();
      for (;;) {
        const last = log[log.length - 1];
        if (last && Date.now() - t0 - last.t > ms && last.type !== 'play') return;
        if (Date.now() - start > max) return;
        await page.waitForTimeout(200);
      }
    },
  };
}
