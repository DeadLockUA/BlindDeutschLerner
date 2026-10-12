# Немецкий на слух (BlindDeutschLerner)

An audio-first German course (level A1) for blind and visually impaired Russian
speakers. It is a Progressive Web App: open it in Chrome on Android, install it to the
home screen, and it works offline.

**Open the app:** https://deadlockua.github.io/BlindDeutschLerner/
**Instructions for the sighted helper (Russian):** https://deadlockua.github.io/BlindDeutschLerner/help.html

## How it works

- The app speaks everything itself (no screen reader needed): Russian prompts, German
  words in a male and a female voice, dialogues and grammar explanations.
- The screen is split into 4 big coloured zones (6 in "professional" mode). A short tap
  speaks a zone, holding it for 2 seconds selects it (rising tone, vibration ticks, the
  zone fills with colour). The bottom-right zone is always the menu.
- Correct answer: the whole screen flashes green; wrong: red.
- 65 lessons in 13 modules following Goethe-Zertifikat A1 (764 words, 356 phrases,
  grammar, dialogues, listening exam training), spaced-repetition review, pronunciation
  practice and voice commands (Chrome speech recognition, online), progress kept only on
  the phone with backup to Google Drive through the share sheet.
- Optional LLM assistant and German conversation practice through free OpenRouter
  models, with the user's own key.

## Development

```sh
npm ci
npm run dev            # compiles content, starts Vite
npm test               # unit tests
npm run build && npx playwright test   # e2e + accessibility tests
```

- Course sources: `content/modules/*.yaml`, `content/prompts.yaml` — see
  [docs/content-guide.md](docs/content-guide.md) and [docs/course-plan.md](docs/course-plan.md).
- Audio is pre-generated (Qwen3-TTS for German, ESpeech for Russian) and committed; see [docs/voices.md](docs/voices.md).
- Product decisions: [docs/decisions.md](docs/decisions.md).
- CI (GitHub Actions) validates content, type-checks, runs unit, e2e and accessibility
  tests and deploys `main` to GitHub Pages.

## License

Code: MIT (see [LICENSE](LICENSE)). Voice licences: [docs/voices.md](docs/voices.md).
