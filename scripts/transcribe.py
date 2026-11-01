# Hindi word timings for an own-voice reel, with my standard settings:
# faster-whisper "small", int8, VAD on, beam 1, language hi, word timestamps.
# Usage: python transcribe.py <16k mono wav> <out.json>   -> [{"w": word, "s": start, "e": end}, ...]
import json
import os
import sys

from faster_whisper import WhisperModel

audio, out = sys.argv[1], sys.argv[2]
model = WhisperModel("small", device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4, num_workers=2)
segments, _ = model.transcribe(audio, language="hi", beam_size=1, vad_filter=True, word_timestamps=True)
words = [
    {"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)}
    for seg in segments
    for w in (seg.words or [])
    if w.word.strip()
]
with open(out, "w", encoding="utf-8") as f:
    json.dump(words, f, ensure_ascii=False)
print(len(words), "words")
