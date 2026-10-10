# Decisions — BlindDeutschLerner

This document records every decision made during the brainstorming sessions with the
project owner (held in Russian; recorded here in English). It is the **single source of
truth** for the implementation. Where it is silent, the implementer decides, records the
decision in the "Implementation log" section at the end, and moves on.

---

## 0. How the implementation session works

- The owner will open a new Claude Code session on this repository and write
  **«начинай»** ("start"). From that moment the implementer works **fully autonomously
  until the whole product is finished** and does not come back to the owner with
  questions. All questions were closed during brainstorming.
- If something proves technically impossible, the implementer picks the closest
  workable substitute, records the decision and the reason in the Implementation log,
  and continues.
- Language: chat with the owner in **Russian**. Code, comments, commits and repo
  documentation in **English**. All user-facing app content (prompts, explanations,
  helper instructions) in **Russian** (plus German learning material).
- Git: work on the session's designated feature branch, commit and push often (the
  container is ephemeral). At the end open a PR into `main` and **merge it yourself once
  build and tests are green**. `main` must always stay working.
- CI: set up GitHub Actions — build, tests, automated accessibility checks, and
  deployment to **GitHub Pages** via Actions.
  - The owner has **already enabled** Settings → Pages → Source → **GitHub Actions**,
    so deployment must work and be verified (the site URL should respond).
- Multi-agent / subagents: use them **only** when they give a speed gain without extra
  cost, a cost saving (e.g. a cheaper model for bulk mechanical work such as content
  generation or audio checks), or a quality gain (a stronger model for hard tasks).
- **OpenRouter key:** the owner configured it as a **Network secret** of the cloud
  environment: the egress proxy injects `Authorization: Bearer <key>` into requests to
  `openrouter.ai/api/v1/…`. So there is **no env var** and the key value is never visible.
  At the start, probe it with an authenticated-only endpoint without sending any key,
  e.g. `curl -sS https://openrouter.ai/api/v1/key` (200 = secret works, 401 = missing).
  (Also check `OPENROUTER_API_KEY` in env as a fallback; never print values.) If it
  works, test the LLM assistant against real free models from the container (e.g. a
  small Node/Python smoke-test script sending requests without its own key; the app
  itself must still send the user's key from the phone). If not, test against a stub and
  note in the final report that the real-model path is unverified.
- **Final report** (in Russian, to the owner): what was built, the GitHub Pages link,
  how to set it up, and a **manual test checklist** for things that cannot be verified
  in a cloud container (real audio, touch/hold behaviour on a phone, speech recognition,
  vibration, installation as an app, backup via share sheet, LLM with a real key).
- The owner will check the app quickly, then hand it to the blind/low-vision learner.

## 1. Product

- **Name on the home screen:** «Немецкий на слух».
- **Form factor:** a **PWA** hosted on **GitHub Pages**, installed on Android through
  Chrome ("Install" / "Add to home screen"), works **offline** after lessons are
  downloaded. No native APK.
- **Scope:** a **complete A1 course** based on **Goethe-Zertifikat A1** (topics + the
  official ~650-word list) plus ~300 useful everyday words.
- **License:** code under **MIT**. Use only TTS voices whose licenses permit this use;
  record voice licenses in the repo.
- **Content** (words, phrases, dialogues, grammar explanations, exercises) is authored by
  the implementer; the owner accepts that nobody reviews it before the final check.
  Correctness of German matters — be careful.

## 2. The learner

- Native language: **Russian**. All instructions and explanations are in Russian.
- Beginner; already knows ~200–300 German words.
- Vision: sees **blurry**, but **can distinguish colours** (e.g. a full-screen green or
  red flash). Cannot read normal text.
- **Barely uses a phone.** **TalkBack is OFF** and will stay off — the app must be
  **self-voicing** (it speaks everything itself).
- Can reliably touch a **quarter of the screen**.
- Physical buttons would be fine for him, but a PWA cannot receive Android volume-key
  events, so control is by **touch**. (A Bluetooth keyboard-like clicker could be
  supported later — keyboard events may be handled, but are not required.)
- Will use either the phone speaker or headphones.
- Setup is done by a **sighted helper**, who must find it "as simple as for a grandma".
  The owner can help in the worst case, but setup should not need him.

## 3. Interaction model

### Screen grid
- **Basic mode (default): 2×2 grid.** Three zones are answer options, **one zone is
  always "Menu" — bottom-right**, same colour on every screen.
- **"Professional" mode: 2×3 grid** (2 top, 2 middle, 2 bottom): five answer options +
  the same **Menu zone in the bottom-right**.
- Pro mode is switched on by the helper in settings; additionally the app **offers it by
  voice** when the learner has been answering almost without mistakes for a long time.
- Yes/No questions use two of the zones.

### Touch semantics
- **Short tap** on a zone → speaks that zone's content/option.
- **Hold 2 seconds** → selects. While holding: rising tone + light vibration ticks + the
  zone gradually fills with colour; at 2 s a strong vibration and the choice is
  accepted. Releasing earlier does nothing.
- Hold duration configurable in settings (**1–4 s**, default **2 s**).
- **Menu zone:** short tap = repeat the question; hold 2 s = pause menu.
- **Settings** are hidden from the learner: entered by **holding the Menu zone for
  5 seconds**.
- All menus (main menu, pause menu) use the same grid: one item per zone, tap to hear,
  hold to select; if there are more items than zones, one zone becomes "more".

### Main menu
- «Продолжить обучение» — review (spaced repetition) + next lesson.
- «Выбрать урок» — the learner can navigate modules/lessons himself.
- «Мой прогресс» — spoken summary (words learned, lessons done, what to review).
- «Помощник» — voice question to the LLM assistant.
- Settings — hidden (5 s hold on Menu).

### Feedback & visuals
- **Dark background** with bright saturated zone colours.
- **Pure green / red are reserved** for correct / wrong feedback (full-screen flash +
  short sound + vibration). Zones use other fixed colours across the whole app (e.g.
  yellow, blue, purple, white…).
- Zones also show **very large text** (helps residual vision and the sighted helper).
- **Screen stays awake** during lessons (Wake Lock).
- **Portrait orientation locked.**
- Vibration feedback is welcome.

### Behaviour details
- On launch the app **immediately greets by voice** and offers to continue where the
  learner left off — no splash screens or visual-only steps.
- **First launch:** a short spoken tutorial ("here are the zones; tap to listen, hold to
  choose…").
- **No touch for 15 s** → repeat the question. **2 min of silence** → auto-pause and save
  position.
- After many consecutive mistakes (fatigue) the app **suggests a break / ending the
  session**.
- Voice commands and assistant questions are activated **only via a menu item
  ("Сказать команду")**: a beep, then the app listens for a few seconds. No always-on
  microphone.
- Voice commands use Chrome's built-in speech recognition (needs internet); touch
  remains the primary control. Simple commands: "дальше", "повтори", "меню" etc.

## 4. Audio

- **Hybrid:** all course material and all Russian prompts are **pre-generated audio
  files** made with **Piper** neural TTS (available via PyPI + Hugging Face voices). The
  device's system TTS (Web Speech API) is used **only for dynamic content** (LLM
  assistant replies).
- German words in **two voices — male and female**.
- **Speech-rate control** desired (e.g. slower for new words).
- Lessons are **downloaded progressively** (not the whole course at once); a lesson needs
  internet once, then works offline. Rough total budget 50–150 MB.

## 5. Course structure

~12 modules × ~5 lessons (~60 lessons, 2–3 months of daily study), draft topics:

1. Greetings, introductions, alphabet, name / origin
2. Numbers, age, phone numbers, prices
3. Family, friends
4. Food and drink, shop, café
5. Home and flat, furniture
6. Time, clock, weekdays, months, daily routine
7. City, transport, directions
8. Shopping, clothes, colours
9. Health, body, at the doctor
10. Work, professions, hobbies
11. Weather, seasons, plans
12. Travel, hotel, station, review

Plus a final **exam-training module**: listening (Hören) in Goethe A1 format.

Grammar spread through the course: articles der/die/das, present tense conjugation,
sein/haben, word order, questions, negation nicht/kein, Akkusativ, modal verbs,
separable verbs, possessive pronouns, prepositions of place and time, imperative, intro
to Perfekt and war/hatte.

- Form of address: **primarily *Sie***; ***du*** mentioned briefly without separate drills.
- **No separate phonetics block.**
- Already-known words: start from the beginning, but a word answered correctly on first
  encounter is immediately marked learned (fast pass; no placement test).

### Lesson flow (15–20 min)
1. Introduction — German word/phrase, translation, example sentence.
2. Recognition — German word → choose Russian translation among the options.
3. Reverse — Russian word → choose German option.
4. Yes/No — "*der Hund* means 'cat'?"
5. Say it yourself — pronunciation via speech recognition (online only; skipped
   offline). Lenient check: correct if recognised words match (ignoring case/punctuation
   and small details); 2 attempts, then the app says the correct form and moves on.
6. Mini-dialogue by ear + 2–3 comprehension questions.
7. Grammar — short Russian audio explanation with examples + choice exercises.
8. Spoken lesson summary.

Every session starts with ~5 min of **spaced-repetition review**, then the new lesson.

## 6. Progress & data

- Stored **only on the phone**; no accounts, no cloud backend.
- **One learner** per phone; no profiles.
- Spoken progress summary on request.
- **Helper statistics screen** (visual): lessons done, weak words, day streak.
- **Backup (variant B — no Google Cloud):** once a week the app reminds by voice
  ("попросите помощника сохранить копию"). Helper taps «Сохранить копию» → Android share
  sheet (Web Share API with a file) → Google Drive. Restore: «Загрузить копию» → pick
  the file. Provide a download fallback if file sharing is unavailable.

## 7. LLM assistant (OpenRouter, optional)

- The app works **fully without it**. Enabled when a key is present.
- **Key handling:** stored only on the phone. Two ways to enter it: a normal field in
  settings, and a **special link with the key embedded** (e.g. in the URL fragment) that
  the helper opens once on the learner's phone — the key is saved automatically and
  removed from the address bar. Write instructions for the owner on how to build that
  link.
- The model does **not** control the app directly: it picks a command from a **fixed
  whitelist** (open lesson N, review topic X, repeat, …) or returns an explanation; the
  app executes only whitelisted commands.
- Replies in **Russian**, short (2–3 sentences), simple words; German examples spoken
  with a German voice.
- **"Conversation practice" mode:** simple A1 dialogue in German on the topic of a
  completed lesson (e.g. café); learner answers by voice; the assistant gently corrects.
  Online + key only.
- The assistant receives **learning statistics only** (learned words, weak topics) — no
  personal data.
- Free models chosen by the implementer, with a **fallback list** (if one is unavailable,
  try the next).
- No key / no network → the assistant politely says it is unavailable.

## 8. Helper documentation

- A **Russian, large-print, step-by-step instruction page** on the site for the helper:
  installing the app, granting microphone permission, saving/restoring a backup,
  entering the key, switching modes.

---

## Implementation log

Decisions taken during implementation (date, decision, reason) go here.
