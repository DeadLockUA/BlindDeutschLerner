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
VERIFY = False
_asr = None

VOWELS = 'аеёиоуыэюяaeiouäöü'


def _stretch(text, key):
    """Lengthens the last vowel of a one-word text: "Да." -> "Да-а." (helps tiny words)."""
    words = text.split()
    if len(words) != 1:
        return None
    w = words[0]
    core = w.rstrip('.!?,…')
    if len(core) > 4 or not core or core[-1].lower() not in VOWELS:
        return None
    return core + '-' + core[-1].lower() + w[len(core):]


def _norm(s):
    import re
    s = s.lower().replace('ё', 'е').replace('ß', 'ss')
    s = re.sub(r"[^\w\s]", ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def _verify(x, sr, text, lang):
    """Transcribes the clip and returns similarity to the text (0..1)."""
    global _asr
    import difflib
    import numpy as np
    if _asr is None:
        from faster_whisper import WhisperModel
        _asr = WhisperModel('small', device='cpu', compute_type='int8')
    pad = np.zeros(int(sr * 0.6), np.float32)
    y = np.concatenate([pad, x, pad])
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, 'v.wav')
        with wave.open(wav, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((np.clip(y, -1, 1) * 32767).astype(np.int16).tobytes())
        segs, _ = _asr.transcribe(wav, language=lang, beam_size=5)
        got = _norm(' '.join(seg.text for seg in segs))
    want = _norm(text)
    if not got:
        return 0.0
    if got.isdigit():
        return 0.85  # numbers come back as digits: the word was heard
    if got == want or want.endswith(got) or got.endswith(want):
        return 1.0
    return difflib.SequenceMatcher(None, want, got).ratio()


def ensure_voice(vdir, key):
    return ensure_model(vdir, VOICES[key]['model'])


def ensure_model(vdir, model):
    name = os.path.basename(model)
    path = os.path.join(vdir, name + '.onnx')
    for suffix in ('.onnx', '.onnx.json'):
        target = os.path.join(vdir, name + suffix)
        if not os.path.exists(target):
            print(f'downloading {name}{suffix}', flush=True)
            urllib.request.urlretrieve(HF + model + suffix, target + '.part')
            os.replace(target + '.part', target)
    return path


LEAD_S = 0.35   # silence before speech: Android audio output needs time to wake up
TAIL_S = 0.30   # silence after speech, so the end is never cut off
MIN_SPEECH_S = 0.5  # very short words ("да", "ja") are re-synthesized more slowly
TARGET_RMS_DB = -20.0
PEAK_DB = -1.5


def _speech_bounds(x, sr, thresh=0.02):
    import numpy as np
    win = max(1, int(sr * 0.01))
    env = np.convolve(np.abs(x), np.ones(win) / win, mode='same')
    idx = np.nonzero(env > thresh)[0]
    if len(idx) == 0:
        return 0, len(x)
    return idx[0], idx[-1] + 1


def _synth_array(voice, text, syn):
    import io
    import numpy as np
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        voice.synthesize_wav(text, w, syn)
    buf.seek(0)
    with wave.open(buf) as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    return x, sr


def synth(args):
    global VERIFY
    entry, vdir, VERIFY = args
    import numpy as np
    from piper import PiperVoice, SynthesisConfig

    key = entry['voice']
    cfg = VOICES[key]
    if key not in _loaded:
        _loaded[key] = PiperVoice.load(os.path.join(vdir, os.path.basename(cfg['model']) + '.onnx'))
    voice = _loaded[key]
    out = os.path.join(AUDIO, entry['id'] + '.ogg')
    base_ls = cfg.get('length_scale', 1.0)

    def make(ls, text, model=None):
        syn = SynthesisConfig(
            speaker_id=cfg.get('speaker'),
            length_scale=ls,
            noise_scale=cfg.get('noise_scale', 0.667),
            noise_w_scale=cfg.get('noise_w', 0.8),
        )
        v = voice
        if model:
            if model not in _loaded:
                _loaded[model] = PiperVoice.load(os.path.join(vdir, os.path.basename(model) + '.onnx'))
            v = _loaded[model]
        x, sr = _synth_array(v, text, syn)
        a, b = _speech_bounds(x, sr, 0.005)
        pad = int(sr * 0.03)
        return x[max(0, a - pad):b + pad], sr

    short = len(entry['text'].split()) <= 2
    candidates = [(None, entry['text'], base_ls)]
    if short:
        # Very short words are often swallowed by the voice models ("да", "ja").
        candidates.append((None, entry['text'], base_ls * 1.4))
        stretched = _stretch(entry['text'], key)
        if stretched:
            candidates.append((None, stretched, base_ls))
        if cfg.get('fallback'):
            candidates.append((cfg['fallback'], entry['text'], base_ls))

    best = None
    for model, text, ls in candidates:
        x, sr = make(ls, text, model)
        dur = len(x) / sr
        if dur < MIN_SPEECH_S and model is None:
            x, sr = make(min(ls * MIN_SPEECH_S / max(dur, 0.05), ls * 1.8), text, model)
        # Whisper is slow: check the weak voice always, others only when suspiciously short.
        needs_check = short and VERIFY and (cfg.get('verify_all') or len(x) / sr < 0.45 or model is not None or text != entry['text'])
        if not needs_check:
            best = (x, sr)
            break
        score = _verify(x, sr, entry['text'], 'ru' if key == 'ru' else 'de')
        if best is None or score > best[2]:
            best = (x, sr, score, text, model, ls)
        if score >= 0.8:
            break
    x, sr = best[0], best[1]
    if short and VERIFY and len(best) > 2 and (best[3] != entry['text'] or best[4] or best[5] != base_ls):
        print(f"  fixed {key} {entry['text']!r}: text={best[3]!r} model={best[4] or 'same'} ls={best[5]:.2f} score={best[2]:.2f}", flush=True)
    elif short and VERIFY and len(best) > 2 and best[2] < 0.8:
        print(f"  unverified {key} {entry['text']!r} score={best[2]:.2f}", flush=True)

    # Loudness: same average level for all clips, without clipping.
    rms = float(np.sqrt(np.mean(x ** 2))) or 1e-6
    gain = 10 ** (TARGET_RMS_DB / 20) / rms
    peak = float(np.max(np.abs(x))) or 1e-6
    gain = min(gain, 10 ** (PEAK_DB / 20) / peak)
    x = x * gain
    # Short fades avoid clicks at the edges of the speech.
    f = min(len(x) // 4, int(sr * 0.01))
    if f > 0:
        x[:f] *= np.linspace(0, 1, f)
        x[-f:] *= np.linspace(1, 0, f)
    x = np.concatenate([np.zeros(int(sr * LEAD_S), np.float32), x, np.zeros(int(sr * TAIL_S), np.float32)])
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)

    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, 'a.wav')
        with wave.open(wav, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm.tobytes())
        af = cfg.get('filter', '')
        cmd = ['ffmpeg', '-v', 'error', '-y', '-i', wav]
        if af:
            cmd += ['-af', af]
        cmd += ['-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'audio', out + '.part.ogg']
        subprocess.run(cmd, check=True)
        os.replace(out + '.part.ogg', out)
    return entry['id']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--voices', default=os.environ.get('PIPER_VOICES', os.path.expanduser('~/.cache/piper-voices')))
    ap.add_argument('--jobs', type=int, default=max(1, (os.cpu_count() or 2) - 0))
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--verify', action='store_true', help='check short clips with Whisper and fix bad ones')
    a = ap.parse_args()
    global VERIFY
    VERIFY = a.verify
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
        if VOICES[key].get('fallback'):
            ensure_model(a.voices, VOICES[key]['fallback'])
    # Group by voice so each worker loads few models.
    todo.sort(key=lambda e: e['voice'])
    done = 0
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        for _ in ex.map(synth, [(e, a.voices, VERIFY) for e in todo], chunksize=16):
            done += 1
            if done % 200 == 0:
                print(f'  {done}/{len(todo)}', flush=True)
    print('done', flush=True)


if __name__ == '__main__':
    sys.exit(main())
