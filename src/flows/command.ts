// Voice commands and questions to the assistant.

import type { App } from '../app';
import { sfx } from '../audio/sfx';
import { askAssistant, LlmError, type AssistantCommand } from '../engine/llm';
import { dueCount, learnedCount, weakWords } from '../engine/srs';
import { canListen, listen, speakSystem, splitMarked, stopSystemSpeech } from '../engine/speech';
import { Navigate, type Route } from '../ui/ui';

export type LocalCommand = { kind: 'route'; route: Route } | { kind: 'resume' } | { kind: 'progress' };

/** Parses simple Russian voice commands without the LLM. */
export function parseLocalCommand(text: string, lessonIds: string[]): LocalCommand | null {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  const nums = [...t.matchAll(/\d+/g)].map((m) => Number(m[0]));
  if (/модул/.test(t) && /урок/.test(t) && nums.length >= 2) {
    const id = `m${String(nums[0]).padStart(2, '0')}l${String(nums[1]).padStart(2, '0')}`;
    if (lessonIds.includes(id)) return { kind: 'route', route: { name: 'lesson', id } };
  }
  if (/повторени|повтор\S* слов/.test(t)) return { kind: 'route', route: { name: 'review' } };
  if (/^(повтори|ещ[её] раз)/.test(t.trim()) || /^повтор/.test(t.trim())) return { kind: 'resume' };
  if (/главн|меню/.test(t)) return { kind: 'route', route: { name: 'main' } };
  if (/прогресс|статистик|сколько.*(слов|урок)/.test(t)) return { kind: 'progress' };
  if (/разговор|поговор|практик/.test(t)) return { kind: 'route', route: { name: 'talk' } };
  if (/как пользоваться|обучени|инструкци/.test(t)) return { kind: 'route', route: { name: 'tutorial' } };
  if (/выбрать урок|выбор урока|список урок/.test(t)) return { kind: 'route', route: { name: 'choose' } };
  if (/^(дальше|далее|продолж|следующ|начать|начнем|учить)/.test(t.trim()) || /продолж/.test(t)) return { kind: 'resume' };
  if (/пауза|стоп|хватит/.test(t)) return { kind: 'route', route: { name: 'main' } };
  return null;
}

function routeFor(c: AssistantCommand): Route {
  switch (c.type) {
    case 'continue':
      return { name: 'continue' };
    case 'open_lesson':
      return { name: 'lesson', id: c.lesson };
    case 'review':
      return { name: 'review' };
    case 'progress':
      return { name: 'progress' };
    case 'main_menu':
      return { name: 'main' };
    case 'talk':
      return { name: 'talk' };
  }
}

export async function runCommand(app: App, opts: { fromPause: boolean }): Promise<void> {
  if (!canListen()) {
    await app.say(app.P('cmd_no_net'));
    return;
  }
  await app.say(app.P('cmd_listen'));
  sfx.listen();
  const r = await listen('ru-RU');
  if (!r.ok) {
    await app.say(app.P(r.error === 'denied' ? 'mic_error' : r.error === 'offline' ? 'cmd_no_net' : 'no_speech'));
    return;
  }
  const text = r.alternatives[0] ?? '';
  const local = parseLocalCommand(text, app.course.lessonIds);
  if (local) {
    if (local.kind === 'resume') {
      if (opts.fromPause) return;
      throw new Navigate({ name: 'continue' });
    }
    if (local.kind === 'progress') {
      await app.say(...app.progressUtts());
      return;
    }
    throw new Navigate(local.route);
  }
  if (!app.settings.apiKey) {
    await app.say(app.P('cmd_not_understood'));
    return;
  }
  void app.say(app.P('assistant_wait'));
  try {
    const p = app.progress;
    const words = await app.course.words(weakWords(p, 10));
    const reply = await askAssistant(app.settings.apiKey, app.settings.model, text, {
      lessons: app.course.index.modules.flatMap((m) => m.lessons.map((l) => ({ id: l.id, title: `${m.title.t}: ${l.title.t}`, done: !!p.lessons[l.id]?.done }))),
      currentLesson: app.currentLesson ?? p.current?.lessonId,
      learnedWords: learnedCount(p),
      weakWords: words.map((w) => `${w.de.t} (${w.ru.t})`),
      dueWords: dueCount(p, app.today),
    });
    app.player.stop();
    if (reply.say) await speakSystem(splitMarked(reply.say), app.settings.rate);
    if (reply.command) {
      if (reply.command.type === 'continue' && opts.fromPause) return;
      throw new Navigate(routeFor(reply.command));
    }
  } catch (e) {
    if (e instanceof Navigate) throw e;
    stopSystemSpeech();
    app.player.stop();
    const kind = e instanceof LlmError ? e.kind : 'unavailable';
    await app.say(app.P(kind === 'no-key' || kind === 'auth' ? 'assistant_no_key' : kind === 'offline' ? 'cmd_no_net' : 'assistant_unavailable'));
  }
}
