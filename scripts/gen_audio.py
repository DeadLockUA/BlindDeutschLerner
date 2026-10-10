#!/usr/bin/env python3
"""Generates missing audio clips listed in public/course/audio-manifest.json.

Each clip is synthesized with Piper, padded with a little silence, loudness-normalized
and encoded as mono Ogg/Opus into public/audio/<id>.ogg.

Usage:
  python scripts/gen_audio.py [--voices DIR] [--jobs N] [--limit N]

Voices are downloaded from Hugging Face (rhasspy/piper-voices) into DIR on first use.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import wave
from concurrent.futures import ProcessPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, 'public', 'course', 'audio-manifest.json')
AUDIO = os.path.join(ROOT, 'public', 'audio')
HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/'

# voice key -> (piper model path on HF, synthesis options)
VOICES = json.load(open(os.path.join(ROOT, 'scripts', 'voices.json')))

_loaded = {}


def ensure_voice(vdir, key):
    model = VOICES[key]['model']
    name = os.path.basename(model)
    path = os.path.join(vdir, name + '.onnx')
    for suffix in ('.onnx', '.onnx.json'):
        target = os.path.join(vdir, name + suffix)
        if not os.path.exists(target):
            print(f'downloading {name}{suffix}', flush=True)
            urllib.request.urlretrieve(HF + model + suffix, target + '.part')
            os.replace(target + '.part', target)
    return path


def synth(args):
    entry, vdir = args
    from piper import PiperVoice, SynthesisConfig

    key = entry['voice']
    cfg = VOICES[key]
    if key not in _loaded:
        _loaded[key] = PiperVoice.load(os.path.join(vdir, os.path.basename(cfg['model']) + '.onnx'))
    voice = _loaded[key]
    out = os.path.join(AUDIO, entry['id'] + '.ogg')
    syn = SynthesisConfig(
        speaker_id=cfg.get('speaker'),
        length_scale=cfg.get('length_scale', 1.0),
        noise_scale=cfg.get('noise_scale', 0.667),
        noise_w_scale=cfg.get('noise_w', 0.8),
    )
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, 'a.wav')
        with wave.open(wav, 'wb') as w:
            voice.synthesize_wav(entry['text'], w, syn)
        af = cfg.get('filter', '')
        chain = 'adelay=80|80,apad=pad_dur=0.15,loudnorm=I=-18:TP=-2:LRA=11'
        if af:
            chain = af + ',' + chain
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-y', '-i', wav, '-af', chain, '-ac', '1', '-ar', '24000',
             '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', out + '.part.ogg'],
            check=True,
        )
        os.replace(out + '.part.ogg', out)
    return entry['id']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--voices', default=os.environ.get('PIPER_VOICES', os.path.expanduser('~/.cache/piper-voices')))
    ap.add_argument('--jobs', type=int, default=max(1, (os.cpu_count() or 2) - 0))
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    os.makedirs(a.voices, exist_ok=True)
    os.makedirs(AUDIO, exist_ok=True)
    entries = json.load(open(MANIFEST))
    todo = [e for e in entries if not os.path.exists(os.path.join(AUDIO, e['id'] + '.ogg'))]
    if a.limit:
        todo = todo[: a.limit]
    print(f'{len(entries)} clips in manifest, {len(todo)} to generate', flush=True)
    if not todo:
        return
    for key in {e['voice'] for e in todo}:
        ensure_voice(a.voices, key)
    # Group by voice so each worker loads few models.
    todo.sort(key=lambda e: e['voice'])
    done = 0
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        for _ in ex.map(synth, [(e, a.voices) for e in todo], chunksize=16):
            done += 1
            if done % 200 == 0:
                print(f'  {done}/{len(todo)}', flush=True)
    print('done', flush=True)


if __name__ == '__main__':
    sys.exit(main())
