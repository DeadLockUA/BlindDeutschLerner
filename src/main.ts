import './styles.css';
import { App } from './app';
import { AudioPlayer, FakePlayer, type Player } from './audio/player';
import { sfx } from './audio/sfx';
import { pushFakeListen, stopSystemSpeech } from './engine/speech';
import { loadSettings, saveSettings } from './engine/store';

const params = new URLSearchParams(location.search);
const test = params.has('test');

/** A key passed in the link (#key=sk-or-...) is saved and removed from the address bar. */
function takeKeyFromUrl(): boolean {
  const m = location.hash.match(/(?:^#|&)key=([^&]+)/);
  if (!m) return false;
  const s = loadSettings();
  s.apiKey = decodeURIComponent(m[1]).trim();
  saveSettings(s);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

type WakeLock = { release(): Promise<void>; released: boolean };
let wakeLock: WakeLock | null = null;

/** Keeps the screen on while the app is used (released on auto-pause). */
export async function keepAwake(): Promise<void> {
  if (wakeLock && !wakeLock.released) return;
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<WakeLock> } };
    wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    /* not supported or denied */
  }
}

export function releaseWakeLock(): void {
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
}

async function main(): Promise<void> {
  const root = document.getElementById('app')!;
  const keySaved = takeKeyFromUrl();
  const player: Player = test ? new FakePlayer(Number(params.get('clipms') ?? 2)) : new AudioPlayer();
  if (test) {
    const w = window as unknown as Record<string, unknown>;
    w.__player = player;
    w.__pushListen = pushFakeListen;
  }
  if (!test && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('sw', e));
  }
  void (navigator.storage as StorageManager | undefined)?.persist?.();
  try {
    (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('portrait').catch(() => undefined);
  } catch {
    /* ignore */
  }

  const app = await App.create({
    player,
    root,
    test,
    idleRepeatMs: Number(params.get('idle') ?? 15000),
    autoPauseMs: Number(params.get('autopause') ?? 120000),
    holdMs: params.has('hold') ? Number(params.get('hold')) : undefined,
  });
  if (test) (window as unknown as Record<string, unknown>).__app = app;

  // Download the app's own phrases and module 1 right away so it works offline from day one.
  if (!test) {
    void app.course.download('core').then(() => app.course.download('m01'));
  }

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    gate.remove();
    player.unlock();
    sfx.unlock();
    void keepAwake();
    void (async () => {
      if (keySaved) await app.say(app.P('key_saved'));
      await app.run();
    })();
  };

  // Mobile browsers allow sound only after a touch, unless the app is installed. Try to
  // start right away; if sound is blocked, wait for the first touch anywhere.
  const gate = document.createElement('button');
  gate.className = 'gate';
  gate.type = 'button';
  gate.textContent = 'Коснитесь экрана, чтобы начать';
  // 'click' (not pointerdown): only the end of a touch counts as a user gesture for audio.
  gate.addEventListener('click', start);
  root.appendChild(gate);

  if (!test) {
    const probe = new Audio(`audio/${app.P('hello').c[0]}.ogg`);
    probe.volume = 0.0001;
    probe
      .play()
      .then(() => {
        probe.pause();
        if (gate.isConnected) start();
      })
      .catch(() => undefined);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void keepAwake();
    else {
      app.save();
      stopSystemSpeech();
    }
    app.ui.visibilityChanged();
  });

  // Android back button / edge swipe: don't close the app, open the pause menu instead
  // (or close the settings screen, which handles it itself).
  history.pushState({ app: true }, '');
  window.addEventListener('popstate', () => {
    history.pushState({ app: true }, '');
    if (document.querySelector('.overlay.open')) return;
    app.ui.back();
  });

  app.onAutoPause = releaseWakeLock;
  root.addEventListener('pointerdown', () => void keepAwake());
}

void main();
