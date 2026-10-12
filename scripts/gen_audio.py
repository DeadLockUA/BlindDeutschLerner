#!/usr/bin/env python3
"""Generates missing audio clips listed in public/course/audio-manifest.json.

Each clip is synthesized with Qwen3-TTS or ESpeech-TTS ("engine" in scripts/voices.json;
Russian stress for ESpeech is marked with RUAccent) or Piper, padded with a little silence, loudness-normalized and
encoded as mono Ogg/Opus into public/audio/<id>.ogg.

Usage:
  python scripts/gen_audio.py [--verify] [--batch N] [--limit N] [--per-voice N]

Neural voices run on the GPU when PyTorch sees one (CUDA or ROCm), otherwise on the CPU.
Piper voices are downloaded from Hugging Face (rhasspy/piper-voices) into --voices.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import urllib.request
import wave
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor

# AMD GPUs: without this MIOpen tunes kernels for every new input length (10x slower).
os.environ.setdefault('MIOPEN_FIND_MODE', 'FAST')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, 'public', 'course', 'audio-manifest.json')
AUDIO = os.path.join(ROOT, 'public', 'audio')
HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/'
CACHE = os.path.expanduser('~/.cache')

# voice key -> engine, model and synthesis options
VOICES = json.load(open(os.path.join(ROOT, 'scripts', 'voices.json'), encoding='utf-8'))

_loaded = {}
VERIFY = False
_asr = None
_asr_lock = threading.Lock()

VOWELS = 'аеёиоуыэюяaeiouäöü'


def _lang(key):
    return 'ru' if key.startswith('ru') else 'de'


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


def _get_asr():
    global _asr
    with _asr_lock:
        if _asr is None:
            from faster_whisper import WhisperModel
            # download_root avoids the Hugging Face cache, which needs symlinks on Windows.
            _asr = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=5,
                                download_root=os.path.join(CACHE, 'faster-whisper-small'))
    return _asr


def _verify(x, sr, text, lang):
    """Transcribes the clip and returns similarity to the text (0..1)."""
    import difflib
    import numpy as np
    from math import gcd
    from scipy.signal import resample_poly
    pad = np.zeros(int(sr * 0.6), np.float32)
    y = np.concatenate([pad, x, pad])
    g = gcd(16000, sr)
    y = resample_poly(y, 16000 // g, sr // g).astype(np.float32)  # Whisper takes 16 kHz
    segs, _ = _get_asr().transcribe(y, language=lang, beam_size=5)
    raw = ' '.join(seg.text for seg in segs)
    want = _norm(text)
    best = 0.0
    # Whisper writes numbers as digits ("7,50 €", "10:15"): compare the spelled-out forms.
    for got in {_norm(raw), _norm(_spell_numbers(raw, lang, 'cardinal')), _norm(_spell_numbers(raw, lang, 'ordinal'))}:
        if not got:
            continue
        if got == want or want.endswith(got) or got.endswith(want):
            return 1.0
        best = max(best, difflib.SequenceMatcher(None, want, got).ratio())
    return best


def _spell_numbers(s, lang, to):
    """'7,50 € um 10:15' -> 'семь пятьдесят евро ...' (num2words; unchanged if it is missing)."""
    import re
    try:
        from num2words import num2words
    except ImportError:
        return s
    s = s.replace('€', ' евро ' if lang == 'ru' else ' Euro ').replace('%', ' процентов ' if lang == 'ru' else ' Prozent ')
    s = re.sub(r'(?<=\d)[ .](?=\d{3}\b)', '', s)  # thousands: 25 000, 25.000
    s = re.sub(r'(\d)[:.,](\d)', r'\1 \2', s)  # 10:15, 7,50
    return re.sub(r'\d+', lambda m: ' ' + num2words(int(m.group(0)), lang=lang, to=to) + ' ', s)


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
GOOD_SCORE = 0.8


def _speech_bounds(x, sr, thresh=0.02):
    import numpy as np
    win = max(1, int(sr * 0.01))
    env = np.convolve(np.abs(x), np.ones(win) / win, mode='same')
    idx = np.nonzero(env > thresh)[0]
    if len(idx) == 0:
        return 0, len(x)
    return idx[0], idx[-1] + 1


def _trim(x, sr):
    a, b = _speech_bounds(x, sr, 0.005)
    pad = int(sr * 0.03)
    return x[max(0, a - pad):b + pad]


def write_clip(x, sr, out, cfg):
    """Normalizes loudness, adds lead/tail silence and encodes `x` to Ogg/Opus at `out`."""
    import numpy as np
    x = np.asarray(x, np.float32).copy()
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


# ---------------------------------------------------------------- Piper

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
        return _trim(x, sr), sr

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
        score = _verify(x, sr, entry['text'], _lang(key))
        if best is None or score > best[2]:
            best = (x, sr, score, text, model, ls)
        if score >= GOOD_SCORE:
            break
    x, sr = best[0], best[1]
    if short and VERIFY and len(best) > 2 and (best[3] != entry['text'] or best[4] or best[5] != base_ls):
        print(f"  fixed {key} {entry['text']!r}: text={best[3]!r} model={best[4] or 'same'} ls={best[5]:.2f} score={best[2]:.2f}", flush=True)
    elif short and VERIFY and len(best) > 2 and best[2] < GOOD_SCORE:
        print(f"  unverified {key} {entry['text']!r} score={best[2]:.2f}", flush=True)
    write_clip(x, sr, out, cfg)
    return entry['id']


# ---------------------------------------------------------------- Qwen3-TTS

ATTEMPTS = 4  # sampling is random: a failed clip is retried with another seed
WINDOW = 256  # clips rendered and checked together; finished clips are written right away


def _score(x, sr, entry, key, verify):
    """0..1: how well the clip says the text. Catches swallowed words and rambling."""
    dur = len(x) / sr
    n = len(entry['text'])
    if dur < 0.2 or dur > 1.5 + 0.15 * n:
        return 0.0
    if not verify:
        return 1.0
    return _verify(x, sr, entry['text'], _lang(key))


_accentizer = None
_stress_fixes = {}
RU_STRESS = os.path.join(ROOT, 'scripts', 'ru_stress.json')


def ru_stress(text):
    """Marks Russian stress in RUAccent format ('прив+ет'), keeping the original case.

    Title-case words are lowercased first (RUAccent stresses them worse), and words listed
    in scripts/ru_stress.json ("держите": "держ+ите") override RUAccent.
    """
    global _accentizer, _stress_fixes
    import re
    if _accentizer is None:
        from ruaccent import RUAccent
        _accentizer = RUAccent()
        _accentizer.load(omograph_model_size='turbo3.1', use_dictionary=True, tiny_mode=False)
        if os.path.exists(RU_STRESS):
            _stress_fixes = json.load(open(RU_STRESS, encoding='utf-8'))
    low = re.sub(r'\b[А-ЯЁ][а-яё]+\b', lambda m: m.group(0).lower(), text)
    out = _accentizer.process_all(low)
    if _stress_fixes:
        out = re.sub(r'[\w+]+', lambda m: _stress_fixes.get(m.group(0).replace('+', ''), m.group(0)), out)
    res, i = [], 0  # RUAccent only inserts '+' (and may turn е into ё): copy the case back
    for ch in out:
        if ch == '+':
            res.append(ch)
            continue
        orig = text[i] if i < len(text) else ch
        res.append(ch.upper() if orig.isupper() else ch)
        i += 1
    return ''.join(res)


class QwenEngine:
    """Qwen3-TTS voice cloning from a reference clip; renders a batch per GPU call."""

    def __init__(self, cfg, dev, batch):
        import torch
        from qwen_tts import Qwen3TTSModel
        self.batch = batch
        self.language = cfg['language']
        self.model = Qwen3TTSModel.from_pretrained(cfg['model'], device_map=dev,
                                                   dtype=getattr(torch, cfg.get('dtype', 'float32')))

    def set_voice(self, cfg):
        self.prompt = self.model.create_voice_clone_prompt(
            ref_audio=os.path.join(ROOT, 'scripts', cfg['ref']), ref_text=cfg['ref_text'])
        self.language = cfg['language']

    def render(self, texts, seed):
        import torch
        torch.manual_seed(seed)
        try:
            wavs, sr = self.model.generate_voice_clone(text=texts, language=[self.language] * len(texts),
                                                       voice_clone_prompt=self.prompt * len(texts))
        except torch.OutOfMemoryError:
            if len(texts) == 1:
                raise
            torch.cuda.empty_cache()  # a batch of long sentences: render it in halves
            h = len(texts) // 2
            return self.render(texts[:h], seed) + self.render(texts[h:], seed + h)
        return [(w, sr) for w in wavs]


class ESpeechEngine:
    """ESpeech-TTS-1 (F5-TTS, Russian only) with RUAccent stress marks; one clip per call."""

    MIN_WORD_S = 0.8

    def __init__(self, cfg, dev, batch):
        import torch
        import torchaudio
        import soundfile as sf
        # The ROCm build of PyTorch for Windows has no torch.distributed (encodec only needs
        # the name) and torchaudio's torchcodec backend does not load: read wav with soundfile.
        if not hasattr(torch.distributed, 'ReduceOp'):
            torch.distributed.ReduceOp = type('ReduceOp', (), {'SUM': 0})

        def load(path, *a, **k):
            x, sr = sf.read(path, dtype='float32', always_2d=True)
            return torch.from_numpy(x.T.copy()), sr
        torchaudio.load = load
        from huggingface_hub import hf_hub_download
        from f5_tts.infer.utils_infer import infer_process, load_model, load_vocoder
        from f5_tts.model import DiT
        self.batch = 1
        self.dev = dev
        self.infer = infer_process
        ckpt = hf_hub_download(cfg['model'], cfg['checkpoint'])
        vocab = hf_hub_download(cfg['model'], 'vocab.txt')
        self.model = load_model(DiT, dict(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512, conv_layers=4),
                                ckpt, vocab_file=vocab, device=dev)
        self.vocoder = load_vocoder(device=dev)

    def set_voice(self, cfg):
        import soundfile as sf
        from f5_tts.infer.utils_infer import preprocess_ref_audio_text
        self.ref_audio, self.ref_text = preprocess_ref_audio_text(
            os.path.join(ROOT, 'scripts', cfg['ref']), ru_stress(cfg['ref_text']), show_info=lambda *a: None)
        self.ref_sec = sf.info(self.ref_audio).duration

    def render(self, texts, seed):
        import torch
        out = []
        for j, t in enumerate(texts):
            torch.manual_seed(seed + j)
            marked = ru_stress(t)
            # F5-TTS gives a text time in proportion to its length; single words get ~0.3 s
            # and come out mumbled. They get at least MIN_WORD_S.
            est = self.ref_sec * len(marked.encode()) / len(self.ref_text.encode())
            fix = self.ref_sec + self.MIN_WORD_S if est < self.MIN_WORD_S else None
            wav, sr, _ = self.infer(self.ref_audio, self.ref_text, marked, self.model, self.vocoder, nfe_step=32,
                                    speed=1.0, fix_duration=fix, device=self.dev, show_info=lambda *a: None)
            out.append((wav, sr))
        return out


ENGINES = {'qwen': QwenEngine, 'espeech': ESpeechEngine}


def gen_neural(todo, verify, batch):
    import numpy as np
    import torch

    dev = 'cuda:0' if torch.cuda.is_available() else 'cpu'
    print(f'neural TTS on {torch.cuda.get_device_name(0) if dev != "cpu" else "CPU"}', flush=True)
    pool = ThreadPoolExecutor(4)  # Opus encoding runs while the GPU works
    # Whisper checks run in separate processes, also in parallel with the GPU. (In one
    # process Whisper's and PyTorch's OpenMP runtimes clash on Windows.)
    checker = pool
    if verify:
        checker = ProcessPoolExecutor(2, initializer=_get_asr)
        # Start the workers and load Whisper before the TTS model takes the memory.
        for f in [checker.submit(_lang, 'ru') for _ in range(2)]:
            f.result()
    total, done = len(todo), 0
    by_voice = {}
    for e in todo:
        by_voice.setdefault(e['voice'], []).append(e)

    eng, eng_key = None, None
    # Voices sharing a model are done one after another; the model is loaded once.
    for key in sorted(by_voice, key=lambda k: (VOICES[k]['engine'], VOICES[k]['model'])):
        cfg = VOICES[key]
        if eng_key != (cfg['engine'], cfg['model']):
            eng = None
            torch.cuda.empty_cache()
            print(f'loading {cfg["engine"]} {cfg["model"]}', flush=True)
            eng, eng_key = ENGINES[cfg['engine']](cfg, dev, batch), (cfg['engine'], cfg['model'])
        eng.set_voice(cfg)
        # Similar lengths in one batch: less padding, faster.
        entries = sorted(by_voice[key], key=lambda e: len(e['text']))
        for w0 in range(0, len(entries), WINDOW):
            pending = entries[w0:w0 + WINDOW]
            best = {}  # id -> (score, x, sr, text) for clips that did not pass yet
            for attempt in range(ATTEMPTS):
                if not pending:
                    break
                jobs = []
                for i in range(0, len(pending), eng.batch):
                    chunk = pending[i:i + eng.batch]
                    texts = []
                    for e in chunk:
                        st = _stretch(e['text'], key) if attempt == ATTEMPTS - 1 else None
                        texts.append(st or e['text'])
                    for e, t, (w, sr) in zip(chunk, texts, eng.render(texts, attempt * 1000003 + w0 + i)):
                        x = _trim(np.asarray(w, np.float32), sr)
                        jobs.append((e, t, x, sr, checker.submit(_score, x, sr, e, key, verify)))
                    if attempt == 0:
                        done += len(chunk)
                        if done // 200 != (done - len(chunk)) // 200:
                            print(f'  {done}/{total}', flush=True)
                retry = []
                for e, t, x, sr, fut in jobs:
                    score = fut.result()
                    if score >= GOOD_SCORE:
                        if attempt:
                            print(f"  fixed {key} {e['text']!r}: attempt {attempt + 1}, text={t!r} score={score:.2f}", flush=True)
                        best.pop(e['id'], None)
                        pool.submit(write_clip, x, sr, os.path.join(AUDIO, e['id'] + '.ogg'), cfg)
                    else:
                        if e['id'] not in best or score > best[e['id']][0]:
                            best[e['id']] = (score, x, sr, t)
                        retry.append(e)
                pending = retry
            for e in pending:
                score, x, sr, t = best[e['id']]
                print(f"  unverified {key} {e['text']!r} best={t!r} score={score:.2f}", flush=True)
                pool.submit(write_clip, x, sr, os.path.join(AUDIO, e['id'] + '.ogg'), cfg)
    pool.shutdown(wait=True)
    checker.shutdown(wait=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--voices', default=os.environ.get('PIPER_VOICES', os.path.join(CACHE, 'piper-voices')))
    ap.add_argument('--jobs', type=int, default=max(1, (os.cpu_count() or 2) - 0), help='Piper worker processes')
    ap.add_argument('--batch', type=int, default=8, help='Qwen3-TTS clips per GPU batch')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--per-voice', type=int, default=0, help='only the first N missing clips of each voice (trial run)')
    ap.add_argument('--verify', action='store_true', help='check clips with Whisper and fix bad ones')
    ap.add_argument('--only', default='', help='comma-separated voice keys (used internally)')
    a = ap.parse_args()
    global VERIFY
    VERIFY = a.verify
    os.makedirs(AUDIO, exist_ok=True)
    entries = json.load(open(MANIFEST, encoding='utf-8'))
    todo = [e for e in entries if not os.path.exists(os.path.join(AUDIO, e['id'] + '.ogg'))]
    if a.only:
        todo = [e for e in todo if e['voice'] in a.only.split(',')]
    if a.per_voice:
        count, picked = {}, []
        for e in todo:
            count[e['voice']] = count.get(e['voice'], 0) + 1
            if count[e['voice']] <= a.per_voice:
                picked.append(e)
        todo = picked
    if a.limit:
        todo = todo[: a.limit]
    print(f'{len(entries)} clips in manifest, {len(todo)} to generate', flush=True)
    if not todo:
        return
    neural = [e for e in todo if VOICES[e['voice']].get('engine') in ENGINES]
    piper = [e for e in todo if VOICES[e['voice']].get('engine') not in ENGINES]
    groups = {}
    for e in neural:
        cfg = VOICES[e['voice']]
        groups.setdefault((cfg['engine'], cfg['model']), set()).add(e['voice'])
    if len(groups) > 1:
        # One process per model: the ROCm build of PyTorch for Windows crashes when a
        # process loads a second model.
        for keys in groups.values():
            subprocess.run([sys.executable, os.path.abspath(__file__)] + sys.argv[1:] + ['--only', ','.join(sorted(keys))], check=True)
    elif neural:
        gen_neural(neural, VERIFY, a.batch)
    if piper:
        os.makedirs(a.voices, exist_ok=True)
        for key in {e['voice'] for e in piper}:
            ensure_voice(a.voices, key)
            if VOICES[key].get('fallback'):
                ensure_model(a.voices, VOICES[key]['fallback'])
        # Group by voice so each worker loads few models.
        piper.sort(key=lambda e: e['voice'])
        done = 0
        with ProcessPoolExecutor(max_workers=a.jobs) as ex:
            for _ in ex.map(synth, [(e, a.voices, VERIFY) for e in piper], chunksize=16):
                done += 1
                if done % 200 == 0:
                    print(f'  {done}/{len(piper)}', flush=True)
    print('done', flush=True)


if __name__ == '__main__':
    sys.exit(main())
