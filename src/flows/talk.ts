// Conversation practice with the LLM (German dialogue on a learned topic).

import type { App } from '../app';
import { sfx } from '../audio/sfx';
import { LlmError, talkSystemPrompt, talkTurn, type ChatMessage, type TalkTurn } from '../engine/llm';
import { canListen, listen, speakSystem, splitMarked, stopSystemSpeech } from '../engine/speech';
import type { Option } from '../ui/ui';

export async function runTalk(app: App): Promise<void> {
  if (!app.settings.apiKey || !canListen()) {
    await app.say(app.P('talk_need'));
    return;
  }
  const p = app.progress;
  const done = app.course.lessonIds.filter((id) => p.lessons[id]?.done);
  const lessonId = done[done.length - 1] ?? app.course.lessonIds[0];
  const lesson = await app.course.lesson(lessonId);
  const topic = lesson.title.t + (lesson.dialogues[0] ? `, ${lesson.dialogues[0].title.t}` : '');
  const words = [...lesson.words, ...lesson.phrases].map((w) => w.de.t);
  const history: ChatMessage[] = [
    { role: 'system', content: talkSystemPrompt(topic, words) },
    { role: 'user', content: 'Начни разговор: поздоровайся и задай первый простой вопрос по теме.' },
  ];
  await app.say(app.P('talk_intro'));

  let last: TalkTurn | null = null;
  const turn = async (): Promise<boolean> => {
    void app.say(app.P('assistant_wait'));
    const waiting = window.setInterval(() => !app.player.busy && void app.player.play([app.P('assistant_wait')]), 8000);
    try {
      const t = await talkTurn(app.settings.apiKey, app.settings.model, [history[0], ...history.slice(1).slice(-12)]);
      clearInterval(waiting);
      app.player.stop();
      history.push({ role: 'assistant', content: JSON.stringify(t) });
      last = t;
      if (t.fix) await speakSystem(splitMarked(t.fix), app.settings.rate);
      await speakSystem([{ lang: 'de', text: t.de }], app.settings.rate);
      return true;
    } catch (e) {
      clearInterval(waiting);
      app.player.stop();
      stopSystemSpeech();
      const kind = e instanceof LlmError ? e.kind : 'unavailable';
      await app.say(app.P(kind === 'no-key' || kind === 'auth' ? 'assistant_no_key' : 'assistant_unavailable'));
      return false;
    }
  };

  if (!(await turn())) return;
  const options: (Option | null)[] = [app.optKey('z_speak'), app.optKey('z_repeat'), app.optKey('z_translation')];
  while (options.length < app.slots) options.push(null);
  try {
    for (;;) {
      const i = await app.ask({ prompt: [app.P('talk_your_turn')], options, silentStart: true });
      const cur = last as TalkTurn | null;
      if (i === 1 && cur) {
        await speakSystem([{ lang: 'de', text: cur.de }], app.settings.rate * 0.85);
        continue;
      }
      if (i === 2 && cur) {
        await speakSystem([{ lang: 'ru', text: cur.ru || '—' }], app.settings.rate);
        continue;
      }
      if (i !== 0) continue;
      sfx.listen();
      const r = await listen('de-DE', 10000);
      if (!r.ok) {
        await app.say(app.P(r.error === 'denied' ? 'mic_error' : 'no_speech'));
        continue;
      }
      history.push({ role: 'user', content: r.alternatives[0] });
      if (!(await turn())) return;
    }
  } finally {
    stopSystemSpeech();
  }
}
