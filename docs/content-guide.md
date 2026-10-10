# Content guide (course authoring)

The course lives in `content/modules/mNN.yaml` (one file per module). It is compiled by
`node scripts/build-content.mjs`, which validates everything and fails on errors.
`content/modules/m01.yaml` lesson `m01l01` is the reference example — follow its style.

The learner: native Russian speaker, beginner (knows ~200–300 German words), poor
eyesight, studies **only by ear**. Everything is spoken by TTS, so:

- Write text that sounds natural when read aloud. No tables, no slashes like
  "der/die", no abbreviations ("z. B.", "usw.", "т. е.", "напр."), no brackets, no
  emoji. Write "или" instead of "/". Write numbers in German examples as words when
  they are being taught (e.g. "zwei Euro fünfzig"), otherwise digits are fine.
- Russian text: use **ё** where it belongs (TTS stress), short sentences.
- German inside Russian text must be wrapped in `[[...]]`, e.g.
  `"Слово [[der Tisch]] мужского рода."` — the German part is spoken by a German voice.
  Never put Latin letters outside `[[ ]]` in Russian text (except names like Goethe).
- German fields (`de`, `ex`, `plural`, dialogue lines) are plain German, no `[[ ]]`.

## File structure

```yaml
id: m02                       # module id, file must be named m02.yaml
title: "Числа и цены"          # Russian, spoken
lessons:                      # 5 lessons per module
  - id: m02l01                # mNNlKK
    title: "Числа от нуля до двенадцати"   # Russian, spoken
    intro: "В этом уроке вы ..."           # one or two Russian sentences
    words:                    # 10–14 NEW single words (nouns with article)
      - de: "der Tisch"       # nouns ALWAYS with article der, die or das
        ru: "стол"            # short Russian translation (spoken as an answer option!)
        plural: "die Tische"  # optional, for nouns (omit if no plural is used)
        ex: "Der Tisch ist neu."   # example sentence, A1 level, uses known words
        exRu: "Стол новый."        # its translation
    phrases:                  # 4–8 useful NEW phrases / chunks (same fields, no plural)
      - de: "Wie viel kostet das?"
        ru: "Сколько это стоит?"
    grammar:                  # optional but most lessons have one (see plan)
      title: "Артикли"
      explain:                # 3–6 short spoken paragraphs in Russian with [[German]]
        - "..."
      exercises:              # 4–6 multiple-choice questions
        - q: "Как правильно?"          # Russian question (may contain [[German]])
          options:                     # 3–5 options, the FIRST one is correct
            - "[[der Tisch]]"          # options can be German ([[...]]) or Russian
            - "[[die Tisch]]"
            - "[[das Tisch]]"
    dialogue:                 # one dialogue per lesson
      title: "В магазине"     # Russian
      speakers: {A: m, B: f}  # voice per speaker: m = male, f = female
      lines:                  # 4–10 lines: [speaker, German, Russian translation]
        - [A, "Guten Tag!", "Добрый день!"]
      questions:              # 2–3 comprehension questions, first option correct
        - q: "Что покупает женщина?"
          options: ["Хлеб", "Молоко", "Сыр"]
```

For several dialogues in one lesson (exam module), use `dialogues:` (a list) instead of
`dialogue:`.

## Rules

- **Every German word/phrase appears as a NEW item only once in the whole course**
  (the compiler rejects duplicates, compared case-insensitively without punctuation).
  Reuse earlier words freely in examples and dialogues.
- `ru` of words is used as a spoken answer option, so keep it short (1–3 words). Give
  the most common meaning; for two meanings use a comma: "женщина, госпожа".
- Translations of options in one question must be clearly distinct; avoid synonyms
  that make two options both correct.
- Multiple-choice options: 3 minimum, 5 recommended for grammar exercises (the basic
  mode shows the correct one plus 2 random wrong ones; the pro mode shows up to 5).
  Wrong options must be plausible but unambiguously wrong.
- Form of address: mainly **Sie**; `du` only mentioned, not drilled.
- German must be correct standard German (Hochdeutsch), A1 level, with correct
  articles, plurals, capitalization and punctuation. Russian must be natural.
- Examples and dialogues should use words from the current and earlier lessons, plus
  very common words. Keep sentences short (max ~10 words).
- Grammar explanations: simple, practical, spoken style, in Russian, with many short
  German examples in `[[ ]]`. Compare with Russian where helpful.
- Dialogue lines: realistic everyday situations, names like Anna, Peter, Herr Müller,
  Frau Schmidt, Maria, Thomas, Lukas, Sophie, Familie Weber.
