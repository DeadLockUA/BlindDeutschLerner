// Optional LLM assistant via OpenRouter free models. The model never controls the app
// directly: it can only pick a command from a fixed whitelist, which the app validates.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const PREFERRED_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3.5-lightning:free',
];

const API = 'https://openrouter.ai/api/v1';
const LAST_GOOD_KEY = 'bdl.llm.lastGood';

export class LlmError extends Error {
  constructor(
    msg: string,
    readonly kind: 'no-key' | 'offline' | 'auth' | 'unavailable',
  ) {
    super(msg);
  }
}

let discovered: string[] | null = null;

/** Free models currently listed by OpenRouter (public endpoint, no key needed). */
async function discoverFreeModels(): Promise<string[]> {
  if (discovered) return discovered;
  try {
    const res = await fetch(`${API}/models`);
    const data = (await res.json()) as { data: { id: string; context_length?: number }[] };
    discovered = data.data
      .map((m) => m.id)
      .filter((id) => id.endsWith(':free') && !/safety|code|guard|embed|vision-only/i.test(id));
  } catch {
    discovered = [];
  }
  return discovered;
}

async function candidates(preferred: string): Promise<string[]> {
  const list: string[] = [];
  const add = (m: string) => m && !list.includes(m) && list.push(m);
  add(preferred);
  try {
    add(localStorage.getItem(LAST_GOOD_KEY) ?? '');
  } catch {
    /* ignore */
  }
  PREFERRED_MODELS.forEach(add);
  (await discoverFreeModels()).forEach(add);
  return list.slice(0, 8);
}

export async function chat(apiKey: string, messages: ChatMessage[], opts: { model?: string; maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
  if (!apiKey) throw new LlmError('no key', 'no-key');
  if (!navigator.onLine) throw new LlmError('offline', 'offline');
  const models = await candidates(opts.model ?? '');
  let lastErr = '';
  // Never keep the learner waiting in silence for long: give up after ~30 s in total.
  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  for (const model of models) {
    const left = deadline - Date.now();
    if (left < 3000) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(left, 20000));
    try {
      const res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': location.origin,
          'X-Title': 'Nemetskiy na slukh',
        },
        body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 400, temperature: 0.4 }),
      });
      if (res.status === 401) throw new LlmError('invalid key', 'auth');
      const data = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
      const text = data.choices?.[0]?.message?.content;
      if (res.ok && text && text.trim()) {
        try {
          localStorage.setItem(LAST_GOOD_KEY, model);
        } catch {
          /* ignore */
        }
        return text;
      }
      lastErr = `${model}: ${res.status} ${data.error?.message ?? ''}`;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      lastErr = `${model}: ${String(e)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new LlmError(lastErr || 'no models', 'unavailable');
}

/** Extracts the first JSON object from a model reply. */
export function parseJson<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1)) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---- Assistant -------------------------------------------------------------------

export type AssistantCommand =
  | { type: 'continue' }
  | { type: 'open_lesson'; lesson: string }
  | { type: 'review' }
  | { type: 'progress' }
  | { type: 'main_menu' }
  | { type: 'talk' };

export interface AssistantReply {
  say: string;
  command: AssistantCommand | null;
}

export interface AssistantContext {
  lessons: { id: string; title: string; done: boolean }[];
  currentLesson?: string;
  learnedWords: number;
  weakWords: string[];
  dueWords: number;
}

export function assistantSystemPrompt(ctx: AssistantContext): string {
  const lessons = ctx.lessons.map((l) => `${l.id} ${l.title}${l.done ? ' (пройден)' : ''}`).join('\n');
  return `Ты — дружелюбный ассистент в аудиокурсе немецкого языка «Немецкий на слух» (уровень A1).
Ученик говорит по-русски, начинающий, плохо видит и всё слушает. Твой ответ будет озвучен голосом.

Правила ответа:
- Отвечай по-русски, коротко: 1–3 простых предложения, без списков, скобок, сокращений и эмодзи.
- Немецкие слова и фразы обязательно заключай в двойные квадратные скобки: [[Guten Tag]].
- Если ученик просит что-то сделать в программе, выбери команду из списка. Иначе command = null.
- Отвечай ТОЛЬКО одним JSON-объектом: {"say": "текст для озвучки", "command": null или команда}.

Команды:
{"type":"continue"} — продолжить обучение (повторение и следующий урок)
{"type":"open_lesson","lesson":"<id урока>"} — открыть конкретный урок
{"type":"review"} — повторить выученные слова
{"type":"progress"} — рассказать о прогрессе
{"type":"main_menu"} — главное меню
{"type":"talk"} — разговорная практика на немецком

Уроки курса:
${lessons}

Сейчас: ${ctx.currentLesson ? `урок ${ctx.currentLesson}` : 'главное меню'}. Выучено слов: ${ctx.learnedWords}. Слов к повторению: ${ctx.dueWords}.
Слова, в которых ученик часто ошибается: ${ctx.weakWords.join(', ') || 'нет'}.`;
}

export function validateCommand(c: unknown, lessonIds: string[]): AssistantCommand | null {
  if (!c || typeof c !== 'object') return null;
  const t = (c as { type?: string }).type;
  switch (t) {
    case 'continue':
    case 'review':
    case 'progress':
    case 'main_menu':
    case 'talk':
      return { type: t };
    case 'open_lesson': {
      const id = String((c as { lesson?: string }).lesson ?? '');
      return lessonIds.includes(id) ? { type: 'open_lesson', lesson: id } : null;
    }
    default:
      return null;
  }
}

export async function askAssistant(apiKey: string, model: string, question: string, ctx: AssistantContext): Promise<AssistantReply> {
  const text = await chat(apiKey, [
    { role: 'system', content: assistantSystemPrompt(ctx) },
    { role: 'user', content: question },
  ], { model });
  const j = parseJson<{ say?: string; command?: unknown }>(text);
  const say = (j?.say ?? text.replace(/[{}"]/g, '')).trim().slice(0, 600);
  return { say, command: validateCommand(j?.command, ctx.lessons.map((l) => l.id)) };
}

// ---- Conversation practice --------------------------------------------------------

export interface TalkTurn {
  de: string;
  ru: string;
  fix: string;
}

export function talkSystemPrompt(topic: string, words: string[]): string {
  return `Ты ведёшь простой разговор на немецком языке с русскоязычным учеником уровня A1, который плохо видит и только слушает.
Тема: ${topic}. Полезные слова: ${words.slice(0, 40).join(', ')}.
Правила:
- Говори по-немецки очень просто: одно-два коротких предложения, вежливое обращение Sie, задавай один вопрос за раз.
- Если в ответе ученика есть ошибка, кратко поправь её по-русски в поле fix, немецкие слова там бери в [[ ]]. Если ошибок нет, fix — пустая строка.
- Если ученик ответил по-русски или не понял, помоги: подскажи по-русски, как ответить.
- Отвечай ТОЛЬКО JSON: {"de": "твоя реплика по-немецки", "ru": "её перевод на русский", "fix": "поправка или пустая строка"}.`;
}

export async function talkTurn(apiKey: string, model: string, history: ChatMessage[]): Promise<TalkTurn> {
  const text = await chat(apiKey, history, { model, maxTokens: 300 });
  const j = parseJson<Partial<TalkTurn>>(text);
  if (!j?.de) return { de: text.replace(/[{}"]/g, '').slice(0, 300), ru: '', fix: '' };
  return { de: String(j.de), ru: String(j.ru ?? ''), fix: String(j.fix ?? '') };
}
