"""Kokoro Hindi voice-over: python tts.py <text_file> <out.wav> [voice] [speed]"""
import sys, pathlib
import soundfile as sf
from kokoro_onnx import Kokoro

ROOT = pathlib.Path(__file__).resolve().parent.parent
text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").strip()
voice = sys.argv[3] if len(sys.argv) > 3 else "hm_omega"
speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0

k = Kokoro(str(ROOT / "models/kokoro-v1.0.int8.onnx"), str(ROOT / "models/voices-v1.0.bin"))
samples, sr = k.create(text, voice=voice, speed=speed, lang="hi")
sf.write(sys.argv[2], samples, sr)
print(f"{len(samples) / sr:.1f}s")
