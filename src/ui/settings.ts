// Helper settings and statistics (a normal, large-print screen for a sighted helper).

import type { App } from '../app';
import { chat, LlmError, PREFERRED_MODELS } from '../engine/llm';
import { dueCount, learnedCount, weakWords } from '../engine/srs';
import { accuracy, emptyProgress, makeBackup, parseBackup, saveProgress, saveSettings, streak, today } from '../engine/store';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
}

function section(title: string, ...children: (Node | string)[]): HTMLElement {
  return el('section', { class: 'card' }, el('h2', {}, title), ...children);
}

function status(): HTMLElement {
  return el('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
}

export function backupFileName(): string {
  return `nemetskiy-na-slukh-${today()}.json`;
}

/** Saves a backup through the share sheet (e.g. to Google Drive) or as a download. */
export async function saveBackup(app: App): Promise<string> {
  const data = JSON.stringify(makeBackup(app.progress, app.settings), null, 1);
  const file = new File([data], backupFileName(), { type: 'application/json' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title: 'Копия прогресса «Немецкий на слух»' });
      app.progress.lastBackup = Date.now();
      app.save();
      return 'Копия сохранена. Проверьте, что выбрали Google Диск.';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'Сохранение отменено.';
    }
  }
  const a = el('a', { href: URL.createObjectURL(file), download: backupFileName() });
  document.body.appendChild(a);
  a.click();
  a.remove();
  app.progress.lastBackup = Date.now();
  app.save();
  return 'Файл копии скачан в папку «Загрузки». Его можно загрузить на Google Диск.';
}

export function openSettings(app: App): Promise<void> {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'overlay open', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' });
    const close = () => {
      window.removeEventListener('popstate', close);
      overlay.remove();
      resolve();
    };
    // Android back button closes the settings.
    window.addEventListener('popstate', close);
    const s = app.settings;

    // Mode
    const modeBasic = el('button', { class: 'choice' + (s.pro ? '' : ' on'), type: 'button', 'aria-pressed': String(!s.pro) }, 'Обычный: 4 части экрана');
    const modePro = el('button', { class: 'choice' + (s.pro ? ' on' : ''), type: 'button', 'aria-pressed': String(s.pro) }, 'Профессионал: 6 частей экрана');
    const setMode = (pro: boolean) => {
      s.pro = pro;
      app.saveSettings();
      modeBasic.classList.toggle('on', !pro);
      modePro.classList.toggle('on', pro);
      modeBasic.setAttribute('aria-pressed', String(!pro));
      modePro.setAttribute('aria-pressed', String(pro));
    };
    modeBasic.onclick = () => setMode(false);
    modePro.onclick = () => setMode(true);

    // Hold time
    const holdOut = el('output', {}, `${(s.holdMs / 1000).toFixed(1)} с`);
    const hold = el('input', { type: 'range', min: '1000', max: '4000', step: '500', value: String(s.holdMs), id: 'hold', 'aria-describedby': 'hold-help' }) as HTMLInputElement;
    hold.oninput = () => {
      s.holdMs = Number(hold.value);
      holdOut.textContent = `${(s.holdMs / 1000).toFixed(1)} с`;
      app.saveSettings();
    };

    // Speech rate
    const rateOut = el('output', {}, `${Math.round(s.rate * 100)}%`);
    const rate = el('input', { type: 'range', min: '0.6', max: '1.3', step: '0.05', value: String(s.rate), id: 'rate' }) as HTMLInputElement;
    rate.oninput = () => {
      s.rate = Number(rate.value);
      rateOut.textContent = `${Math.round(s.rate * 100)}%`;
      app.saveSettings();
    };
    const rateTest = el('button', { type: 'button', class: 'btn' }, 'Прослушать');
    rateTest.onclick = () => void app.player.play([app.P('hello'), app.P('lesson_start')]);

    // German voice
    const voiceSel = el(
      'select',
      { id: 'voice' },
      el('option', { value: 'both' }, 'Оба голоса: мужской и женский'),
      el('option', { value: 'm' }, 'Только мужской'),
      el('option', { value: 'f' }, 'Только женский'),
    ) as HTMLSelectElement;
    voiceSel.value = s.deVoice;
    voiceSel.onchange = () => {
      s.deVoice = voiceSel.value as typeof s.deVoice;
      app.saveSettings();
    };

    // Backup
    const backupStatus = status();
    const saveBtn = el('button', { type: 'button', class: 'btn big' }, 'Сохранить копию');
    saveBtn.onclick = async () => {
      backupStatus.textContent = await saveBackup(app);
    };
    const fileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', id: 'restore-file', 'aria-label': 'Файл копии', tabindex: '-1' }) as HTMLInputElement;
    const loadBtn = el('button', { type: 'button', class: 'btn big' }, 'Загрузить копию');
    loadBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const b = parseBackup(await f.text());
        if (!confirm(`Загрузить копию от ${new Date(b.savedAt).toLocaleString('ru-RU')}? Текущий прогресс будет заменён.`)) return;
        app.progress = b.progress;
        app.progressReplaced = true;
        Object.assign(app.settings, b.settings);
        app.save();
        app.saveSettings();
        backupStatus.textContent = 'Копия загружена.';
        renderStats();
      } catch {
        backupStatus.textContent = 'Это не файл копии программы.';
      }
    };
    const lastBackup = app.progress.lastBackup ? new Date(app.progress.lastBackup).toLocaleDateString('ru-RU') : 'ещё не сохранялась';

    // Assistant key
    const keyInput = el('input', { type: 'password', id: 'apikey', autocomplete: 'off', placeholder: 'sk-or-v1-…', value: s.apiKey, spellcheck: 'false' }) as HTMLInputElement;
    const keyStatus = status();
    const keySave = el('button', { type: 'button', class: 'btn' }, 'Сохранить ключ');
    keySave.onclick = () => {
      s.apiKey = keyInput.value.trim();
      app.saveSettings();
      keyStatus.textContent = s.apiKey ? 'Ключ сохранён.' : 'Ключ удалён.';
    };
    const keyTest = el('button', { type: 'button', class: 'btn' }, 'Проверить');
    keyTest.onclick = async () => {
      keyStatus.textContent = 'Проверяю…';
      try {
        const r = await chat(keyInput.value.trim(), [{ role: 'user', content: 'Ответь одним словом по-немецки: как будет «спасибо»?' }], { model: s.model, maxTokens: 20 });
        keyStatus.textContent = `Работает. Ответ ассистента: ${r.trim().slice(0, 60)}`;
      } catch (e) {
        const k = e instanceof LlmError ? e.kind : 'unavailable';
        keyStatus.textContent = k === 'auth' ? 'Ключ неверный.' : k === 'offline' ? 'Нет интернета.' : k === 'no-key' ? 'Введите ключ.' : 'Бесплатные модели сейчас недоступны, попробуйте позже.';
      }
    };
    const modelSel = el('select', { id: 'model' }, el('option', { value: '' }, 'Автоматически'), ...PREFERRED_MODELS.map((m) => el('option', { value: m }, m))) as HTMLSelectElement;
    modelSel.value = s.model;
    modelSel.onchange = () => {
      s.model = modelSel.value;
      app.saveSettings();
    };

    // Offline download
    const dlStatus = status();
    const dlBtn = el('button', { type: 'button', class: 'btn' }, 'Скачать весь курс');
    const totalMb = (app.course.index.modules.reduce((n, m) => n + m.bytes, 0) / 1e6).toFixed(0);
    dlBtn.onclick = async () => {
      dlBtn.setAttribute('disabled', '');
      let failed = false;
      const mods = app.course.index.modules;
      for (let k = 0; k < mods.length; k++) {
        dlStatus.textContent = `Скачиваю модуль ${k + 1} из ${mods.length}…`;
        if (!(await app.course.download(mods[k].id))) failed = true;
      }
      dlStatus.textContent = failed ? 'Часть файлов не скачалась. Проверьте интернет и повторите.' : 'Весь курс скачан и работает без интернета.';
      dlBtn.removeAttribute('disabled');
    };

    // Reset
    const resetBtn = el('button', { type: 'button', class: 'btn danger' }, 'Сбросить весь прогресс');
    resetBtn.onclick = () => {
      if (!confirm('Удалить весь прогресс ученика? Это нельзя отменить. Сначала лучше сохранить копию.')) return;
      if (!confirm('Точно удалить?')) return;
      app.progress = emptyProgress();
      app.progressReplaced = true;
      saveProgress(app.progress);
      renderStats();
    };
    const tutBtn = el('button', { type: 'button', class: 'btn' }, 'Показать обучение при следующем запуске');
    tutBtn.onclick = () => {
      app.progress.tutorialDone = false;
      app.save();
      tutBtn.textContent = 'Готово';
    };

    const stats = el('div', { class: 'stats' });
    const renderStats = () => {
      stats.replaceChildren(...statsView(app));
    };
    renderStats();

    const closeTop = el('button', { type: 'button', class: 'btn big close' }, 'Закрыть настройки');
    closeTop.onclick = close;
    const closeBottom = el('button', { type: 'button', class: 'btn big close' }, 'Закрыть настройки');
    closeBottom.onclick = close;

    const panel = el(
      'div',
      { class: 'panel' },
      el('h1', { id: 'settings-title' }, 'Настройки для помощника'),
      closeTop,
      section('Статистика ученика', stats),
      section('Режим экрана', el('div', { class: 'row' }, modeBasic, modePro)),
      section(
        'Время удержания для выбора',
        el('label', { for: 'hold' }, 'Сколько держать палец: ', holdOut),
        hold,
        el('p', { id: 'hold-help', class: 'help' }, 'Если ученик часто выбирает случайно — увеличьте. Если ему трудно держать — уменьшите.'),
      ),
      section('Скорость речи', el('label', { for: 'rate' }, 'Скорость: ', rateOut), rate, rateTest),
      section('Немецкий голос', el('label', { for: 'voice' }, 'Какими голосами произносить немецкие слова'), voiceSel),
      section(
        'Копия прогресса (Google Диск)',
        el('p', { class: 'help' }, `Последняя копия: ${lastBackup}. Нажмите «Сохранить копию» и выберите «Google Диск» (или «Диск»). Чтобы восстановить, нажмите «Загрузить копию» и выберите файл.`),
        el('div', { class: 'row' }, saveBtn, loadBtn),
        fileInput,
        backupStatus,
      ),
      section(
        'Ассистент (необязательно)',
        el('p', { class: 'help' }, 'Ключ бесплатного сервиса OpenRouter включает голосового ассистента и разговорную практику. Без ключа программа работает полностью, кроме этих двух функций.'),
        el('label', { for: 'apikey' }, 'Ключ OpenRouter'),
        keyInput,
        el('div', { class: 'row' }, keySave, keyTest),
        keyStatus,
        el('label', { for: 'model' }, 'Модель'),
        modelSel,
      ),
      section('Работа без интернета', el('p', { class: 'help' }, `Уроки скачиваются сами по ходу обучения. Можно скачать весь курс сразу (около ${totalMb} МБ).`), dlBtn, dlStatus),
      section(
        'Прочее',
        el('p', {}, el('a', { href: 'help.html', target: '_blank', rel: 'noopener' }, 'Инструкция для помощника')),
        tutBtn,
        resetBtn,
        el('p', { class: 'help' }, `Версия курса: ${app.course.index.version}`),
      ),
      closeBottom,
    );
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    closeTop.focus();
    void saveSettings;
  });
}

function statsView(app: App): Node[] {
  const p = app.progress;
  const ids = app.course.lessonIds;
  const done = ids.filter((id) => p.lessons[id]?.done).length;
  const acc = accuracy(p);
  const nums = el(
    'dl',
    { class: 'nums' },
    el('dt', {}, 'Выучено слов'),
    el('dd', {}, String(learnedCount(p))),
    el('dt', {}, 'Пройдено уроков'),
    el('dd', {}, `${done} из ${ids.length}`),
    el('dt', {}, 'Слов к повторению'),
    el('dd', {}, String(dueCount(p, app.today))),
    el('dt', {}, 'Дней подряд'),
    el('dd', {}, String(streak(p))),
    el('dt', {}, 'Правильных ответов (недавно)'),
    el('dd', {}, acc === null ? '—' : `${Math.round(acc * 100)}%`),
  );
  // Last 14 days
  const set = new Set(p.days);
  const days = el('div', { class: 'days', 'aria-label': 'Занятия за последние 14 дней' });
  for (let k = 13; k >= 0; k--) {
    const d = new Date();
    d.setDate(d.getDate() - k);
    const on = set.has(today(d));
    days.appendChild(el('span', { class: on ? 'day on' : 'day', title: d.toLocaleDateString('ru-RU') }, String(d.getDate())));
  }
  const modules = el('ul', { class: 'modules' });
  for (const m of app.course.index.modules) {
    const n = m.lessons.filter((l) => p.lessons[l.id]?.done).length;
    modules.appendChild(el('li', {}, `${m.title.t}: ${n} из ${m.lessons.length}`, el('progress', { max: String(m.lessons.length), value: String(n) })));
  }
  const weakList = el('ul', { class: 'weak' });
  const weakIds = weakWords(p, 15);
  void app.course.words(weakIds).then((ws) => {
    for (const w of ws) weakList.appendChild(el('li', {}, `${w.de.t} — ${w.ru.t} (ошибок: ${p.words[w.id]?.bad ?? 0})`));
    if (!ws.length) weakList.appendChild(el('li', {}, 'Пока нет.'));
  });
  return [nums, el('h3', {}, 'Занятия за 14 дней'), days, el('h3', {}, 'Модули'), modules, el('h3', {}, 'Трудные слова'), weakList];
}
