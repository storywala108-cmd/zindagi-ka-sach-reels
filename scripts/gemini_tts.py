"""Gemini TTS voice-over: python gemini_tts.py <text_file> <out.wav> [voice] [model]
Key from env GEMINI_API_KEY (never printed)."""
import sys, os, json, base64, wave, pathlib, urllib.request, urllib.error

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").strip()
voice = sys.argv[3] if len(sys.argv) > 3 else "Charon"
model = sys.argv[4] if len(sys.argv) > 4 else "gemini-3.8-flash-tts"

body = {
    "contents": [{"parts": [{"text": text}]}],
    "generationConfig": {
        "responseModalities": ["AUDIO"],
        "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
    },
}
req = urllib.request.Request(
    f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    data=json.dumps(body).encode(),
    headers={"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]},
)
try:
    d = json.load(urllib.request.urlopen(req, timeout=180))
except urllib.error.HTTPError as e:
    sys.exit(f"HTTP {e.code}: {e.read().decode()[:300]}")
pcm = base64.b64decode(d["candidates"][0]["content"]["parts"][0]["inlineData"]["data"])
with wave.open(sys.argv[2], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm)
print(f"{len(pcm) / 48000:.1f}s")
