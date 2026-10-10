#!/usr/bin/env python3
"""Audio QA: transcribes generated clips with Whisper and reports clips whose
transcription differs a lot from the source text (garbled TTS, wrong language, cut-off).

Usage:
  python scripts/check_audio.py [--sample N] [--min-words 3] [--model small] [--voice ru]

Needs `faster-whisper`. Short clips (single words) are skipped by default because ASR
is unreliable on isolated words.
"""
import argparse
import difflib
import json
import os
import random
import re
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, 'public', 'course', 'audio-manifest.json')
AUDIO = os.path.join(ROOT, 'public', 'audio')

RU_NUM = None


def norm(s):
    s = s.lower().replace('ё', 'е').replace('ß', 'ss')
    s = re.sub(r'[^\w\s]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sample', type=int, default=300)
    ap.add_argument('--min-words', type=int, default=3)
    ap.add_argument('--model', default='small')
    ap.add_argument('--voice', default='')
    ap.add_argument('--threshold', type=float, default=0.75)
    a = ap.parse_args()
    from faster_whisper import WhisperModel

    entries = json.load(open(MANIFEST))
    entries = [e for e in entries if len(e['text'].split()) >= a.min_words and not re.search(r'\d', e['text'])]
    if a.voice:
        entries = [e for e in entries if e['voice'] == a.voice]
    random.seed(1)
    if a.sample and len(entries) > a.sample:
        entries = random.sample(entries, a.sample)
    m = WhisperModel(a.model, device='cpu', compute_type='int8')
    bad = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, e in enumerate(entries):
            src = os.path.join(AUDIO, e['id'] + '.ogg')
            if not os.path.exists(src):
                continue
            wav = os.path.join(tmp, 'a.wav')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-ar', '16000', '-af', 'adelay=500|500,apad=pad_dur=0.5', wav], check=True)
            lang = 'ru' if e['voice'] == 'ru' else 'de'
            segs, _ = m.transcribe(wav, language=lang, beam_size=5)
            got = ' '.join(s.text for s in segs)
            r = difflib.SequenceMatcher(None, norm(e['text']), norm(got)).ratio()
            if r < a.threshold:
                bad.append((r, e, got))
                print(f'{r:.2f} [{e["voice"]}] {e["id"]}: {e["text"]!r} -> {got.strip()!r}', flush=True)
    print(f'\nchecked {len(entries)} clips, {len(bad)} below {a.threshold}')


if __name__ == '__main__':
    main()
