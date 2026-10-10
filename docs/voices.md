# Voices and audio licences

All audio in `public/audio/` is synthesized with [Piper](https://github.com/rhasspy/piper)
(MIT licence) from the course texts in this repository.

| Key | Piper voice | Used for | Training data licence |
|---|---|---|---|
| `de-m` | `de_DE-thorsten-high` | German words, grammar examples, male dialogue roles | [Thorsten-Voice](https://github.com/thorstenMueller/Thorsten-Voice) dataset — CC0 |
| `de-f` | `de_DE-eva_k-x_low` | German words (second voice), example sentences, female dialogue roles | [M-AILABS Speech Dataset](https://www.caito.de/2019/01/03/the-m-ailabs-speech-dataset/) — LibriVox public-domain recordings, M-AILABS licence (modified BSD 3-Clause) |
| `ru` | `ru_RU-denis-medium` | All Russian prompts, translations, explanations | [OHF-Voice voice-datasets](https://github.com/OHF-Voice/voice-datasets) — CC0 |

Voice models are downloaded from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices).

## Why these voices

Candidates were compared automatically: each voice synthesized the same German words
and sentences, which were transcribed back with Whisper. Thorsten (high) and Eva K had
the best sentence intelligibility; Kerstin, Ramona and the multi-speaker MLS model were
clearly worse. Russian female voices were excluded for licence reasons (Irina: licence
unknown; Ruslan: CC BY-NC-SA).

## Regenerating audio

```sh
python -m venv .venv && .venv/bin/pip install piper-tts
node scripts/build-content.mjs          # writes public/course/audio-manifest.json
.venv/bin/python scripts/gen_audio.py   # generates missing clips (downloads voices)
node scripts/prune-audio.mjs            # removes clips no longer referenced
```

Optional QA (needs `faster-whisper`): `python scripts/check_audio.py --voice ru`.
