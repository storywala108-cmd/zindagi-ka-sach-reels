// "Zindagi Ka Sach" story reel pipeline (runs on GitHub Actions or the laptop).
//   node zks.js make [topic]   -> script + voice + images + render (no posting)
//   node zks.js post <runId>   -> publish a rendered reel to the Facebook page
//   node zks.js all            -> make + post (scheduled runs)
// Keys only from .env / repository secrets; masked in every log line.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.REEL_ROOT || path.resolve(__dirname, '..');
const DIR = { temp: path.join(ROOT, 'temp'), output: path.join(ROOT, 'output'), logs: path.join(ROOT, 'logs'), music: path.join(ROOT, 'music'), fonts: path.join(ROOT, 'fonts') };
const FPS = 30, W = 1080, H = 1920, IMG = 1000, IMG_X = 40, IMG_Y = 430;
const CF_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
// our own look: soft storybook doodles, never the reference page's characters or watermark
const STYLE = 'soft hand-drawn storybook illustration, simple stick-figure people with round heads and dot eyes, thin black ink outlines, '
  + 'warm cream paper background, muted earthy watercolor fills, gentle shading, minimal clean composition, square frame, '
  + 'absolutely no text, letters, numbers, signs or watermark';

// ---------- env + logging ----------
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return { ...process.env };
  const env = { ...process.env };
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}
const ENV = loadEnv();
if (/^true$/i.test(process.env.DRY_RUN || '')) ENV.POST_ENABLED = 'false';
const SECRETS = Object.entries(ENV).filter(([k, v]) => /KEY|TOKEN|SECRET|ACCOUNT_ID/i.test(k) && v && v.length > 5).map(([, v]) => v);
const mask = (s) => SECRETS.reduce((t, sec) => t.split(sec).join('***'), String(s));
let RUN = '-';
function log(msg) {
  const line = `${new Date().toISOString()} [${RUN}] ${mask(msg)}`;
  fs.appendFileSync(path.join(DIR.logs, 'reel.log'), line + '\n', 'utf8');
  console.error(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function httpJson(url, opts = {}, timeoutMs = 120000) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
    return { ok: res.ok, status: res.status, body };
  } catch (e) { return { ok: false, status: 0, body: { error: e.message } }; }
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed: ${(r.stderr || r.error || '').toString().slice(-400)}`);
  return r.stdout || '';
}
const dur = (f) => parseFloat(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]));
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function istStamp() {
  const t = new Date(Date.now() + 5.5 * 3600e3).toISOString();
  return { date: t.slice(0, 10), id: t.slice(0, 19).replace(/[-:]/g, '').replace('T', '-') };
}
const runDir = (id) => path.join(DIR.temp, id);
const saveState = (s) => fs.writeFileSync(path.join(runDir(s.runId), 'state.json'), JSON.stringify(s, null, 2), 'utf8');
const loadState = (id) => JSON.parse(fs.readFileSync(path.join(runDir(id), 'state.json'), 'utf8'));

// ---------- step 1: story script (Gemini, JSON) ----------
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    topic: { type: 'STRING' }, title: { type: 'STRING' },
    hook: { type: 'OBJECT', properties: { line1: { type: 'STRING' }, line2: { type: 'STRING' }, highlight: { type: 'STRING' } }, required: ['line1', 'line2', 'highlight'] },
    scenes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { hi: { type: 'STRING' }, roman: { type: 'STRING' }, image: { type: 'STRING' } }, required: ['hi', 'roman', 'image'] } },
    caption: { type: 'STRING' }, hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['topic', 'title', 'hook', 'scenes', 'caption', 'hashtags'],
};
const readList = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')); } catch { return []; } };
function scriptPrompt(topic) {
  const used = readList('logs/used-topics.txt').slice(-60);
  const avoid = readList('avoid-topics.txt');
  return `You write short Hindi story reels for the Facebook page "Zindagi Ka Sach": every reel is ONE short original story or parable (people, animals, a village, a city, an office, a family) that ends on a sharp life lesson about human nature, money, relationships, patience, society or "the system".
${topic ? `Story idea from the owner: "${topic}"` : 'Invent a fresh, surprising story idea yourself.'}
It must feel hand-written by a real Indian storyteller: simple spoken Hindi, short sentences, a twist near the end, and a last line that hits hard. Never preachy, no "आइए जानते हैं", no "तो दोस्तों", no "क्या आप जानते हैं".
Never reuse any of these story ideas (ours, already posted):
${used.length ? used.map((u) => '  - ' + u).join('\n') : '  (none yet)'}
Never tell any of these well-known stories of another page (they must stay different):
${avoid.length ? avoid.map((u) => '  - ' + u).join('\n') : '  (none)'}
Return JSON only:
- topic: the story idea in 4-8 English words (for our used list).
- title: Facebook title in Hinglish (Roman letters), max 70 characters, a curiosity question or bold line, ending with one emoji (💀, 😶, 💔, 🔥, 🤯 or ⏳).
- hook: the text shown on top of the video for the whole reel, Hinglish in Roman letters, like "Bro just exposed the system" / "Har problem permanent nahi hoti": line1 max 22 characters, line2 max 22 characters, highlight = ONE word from line1 or line2 shown in yellow.
- scenes: 6 to 12 scenes telling the WHOLE story: a beginning, what happens, the twist, a clear ending (what finally happened to the characters), and as the LAST scene the lesson in one sharp line. Never stop halfway or leave the ending open. Together 90-180 spoken words (about 35-80 seconds); use only as many words as the story needs. For each scene:
  - hi: what the narrator says, in Hindi Devanagari (English words also in Devanagari). Numbers as words.
  - roman: the SAME words transliterated word by word into simple Hinglish Roman letters (same number of words as hi, same order), e.g. "एक किसान ने" -> "Ek kisaan ne".
  - image: an English description of ONE square illustration for this moment: who, where, what is happening, the emotion. Keep the same characters looking the same across scenes (describe them the same way each time, e.g. "a thin stick-figure man in a blue shirt"). Do NOT name a drawing style (no "realistic", "photo", "cinematic") and no names of people or brands. Nothing gory or medical-graphic. No text in the image.
- caption: 1-2 short Hinglish lines (Roman letters) that make people comment, e.g. a question to the viewer.
- hashtags: 5-7 relevant hashtags.`;
}
async function gemini(model, body) {
  return httpJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ENV.GEMINI_API_KEY }, body: JSON.stringify(body),
  }, 120000);
}
async function stepScript(s, topic, shorter = 0, maxSecs = 88) {
  const models = (ENV.GEMINI_TEXT_MODELS || 'gemini-3.8-flash,gemini-3.6-flash').split(',').map((m) => m.trim()).filter(Boolean);
  const extra = shorter ? `\nIMPORTANT: the last version was too long for ${Math.round(maxSecs)} seconds. Tell the SAME complete story (same ending and lesson) more tightly in at most ${Math.round(maxSecs * 2.1) - shorter * 15} spoken words.` : '';
  const body = { contents: [{ parts: [{ text: scriptPrompt(topic) + extra }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 1.0 } };
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const m of models) {
      const r = await gemini(m, body);
      const txt = r.body?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
      if (!r.ok || !txt) { log(`script ${m}: HTTP ${r.status}`); continue; }
      try {
        const g = JSON.parse(txt);
        if (!Array.isArray(g.scenes) || g.scenes.length < 4 || !g.hook) throw new Error('bad shape');
        g.scenes = g.scenes.filter((x) => x && x.hi && x.image);
        s.gen = g; s.textModel = m;
        log(`script OK (${m}): ${g.title} — ${g.scenes.length} scenes`);
        return;
      } catch (e) { log(`script ${m}: ${e.message}`); }
    }
    await sleep(5000);
  }
  throw new Error('Gemini script failed on every model');
}

// ---------- step 2: voice (always Gemini TTS Charon) ----------
// My reels must always have the Charon voice (2026-11-02: Gemini was busy with 503s at 6 PM and the Kokoro fallback
// changed the voice). So: keep retrying every model for up to ~TTS_ROUNDS rounds, 90 s apart; if Charon still can't
// be had, the run stops without posting (the next scheduled run tries again). Kokoro only if TTS_FALLBACK=kokoro.
async function geminiTts(text, wav) {
  const rounds = parseInt(ENV.TTS_ROUNDS || '10', 10);
  for (let k = 1; k <= rounds; k++) {
    const m = await geminiTtsOnce(text, wav);
    if (m) return m;
    if (k < rounds) { log(`tts round ${k}/${rounds} failed, waiting 90 s`); await sleep(90000); }
  }
  return null;
}
async function geminiTtsOnce(text, wav) {
  const models = (ENV.TTS_MODELS || 'gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview').split(',').map((m) => m.trim());
  for (const m of models) {
    const r = await gemini(m, {
      contents: [{ parts: [{ text }] }], // only the story text: any style line gets read aloud
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: ENV.TTS_VOICE || 'Charon' } } } },
    });
    const b64 = r.body?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!r.ok || !b64) { log(`tts ${m}: HTTP ${r.status} ${JSON.stringify(r.body?.error || '').slice(0, 160)}`); continue; }
    const pcm = Buffer.from(b64, 'base64');
    const raw = wav + '.pcm'; fs.writeFileSync(raw, pcm);
    run('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw, wav]);
    fs.unlinkSync(raw);
    return m;
  }
  return null;
}
async function stepVoice(s) {
  const rd = runDir(s.runId);
  const text = s.gen.scenes.map((x) => x.hi.trim()).join(' ');
  fs.writeFileSync(path.join(rd, 'script.txt'), text, 'utf8');
  const raw = path.join(rd, 'voice_raw.wav');
  s.voiceEngine = await geminiTts(text, raw);
  if (!s.voiceEngine) {
    if (!/^kokoro$/i.test(ENV.TTS_FALLBACK || '')) throw new Error('Charon voice unavailable (Gemini TTS busy) → not posting this run');
    log('Gemini TTS failed on every model → Kokoro fallback (TTS_FALLBACK=kokoro)');
    run(PY, ['-X', 'utf8', '-I', path.join(__dirname, 'tts.py'), path.join(rd, 'script.txt'), raw, 'hm_psi', '0.95']);
    s.voiceEngine = 'kokoro-hm_psi';
  }
  // trim edges, gentle clean-up and level; speed never changed
  // the TTS tail has a faint hiss that loudnorm pumped into a "shhh" at the end (2026-11-02): trim again after
  // loudnorm, then a short fade before the silent pad
  const voice = path.join(rd, 'voice.wav'), trimmed = path.join(rd, 'voice_trim.wav');
  const trim = (db) => `silenceremove=start_periods=1:start_threshold=${db}dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=${db}dB:start_silence=0.08,areverse`;
  run('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-af',
    `${trim(-38)},highpass=f=70,acompressor=threshold=-20dB:ratio=2.5:attack=10:release=150:makeup=2,loudnorm=I=-14:TP=-1.5:LRA=7,${trim(-36)}`,
    '-ar', '48000', '-ac', '1', trimmed]);
  // the TTS often adds a lone noise burst ~0.3 s after the last word: drop anything shorter than 0.6 s that comes
  // after the final pause
  let td = dur(trimmed);
  const sd = spawnSync('ffmpeg', ['-hide_banner', '-i', trimmed, '-af', 'silencedetect=n=-45dB:d=0.2', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
  const lastStart = [...sd.matchAll(/silence_start: ([\d.]+)/g)].map((m) => parseFloat(m[1])).pop();
  if (lastStart && td - lastStart < 0.9 && lastStart > td * 0.8) {
    const tmp = trimmed.replace(/\.wav$/, '_cut.wav');
    run('ffmpeg', ['-v', 'error', '-y', '-i', trimmed, '-t', lastStart.toFixed(3), tmp]);
    fs.renameSync(tmp, trimmed); log(`voice: dropped ${(td - lastStart).toFixed(2)} s tail noise`); td = dur(trimmed);
  }
  run('ffmpeg', ['-v', 'error', '-y', '-i', trimmed, '-af', `afade=t=out:st=${Math.max(0, td - 0.15).toFixed(3)}:d=0.15,apad=pad_dur=0.6`, voice]);
  s.voiceDur = dur(voice);
  log(`voice OK (${s.voiceEngine}): ${s.voiceDur.toFixed(1)} s`);
  // word timings: faster-whisper small (my settings), then mapped onto the script's own words
  const w16 = path.join(rd, 'voice16.wav'), wj = path.join(rd, 'words.json');
  run('ffmpeg', ['-v', 'error', '-y', '-i', voice, '-ar', '16000', '-ac', '1', w16]);
  let heard = [];
  try { run(PY, ['-X', 'utf8', '-I', path.join(__dirname, 'transcribe.py'), w16, wj]); heard = JSON.parse(fs.readFileSync(wj, 'utf8')); }
  catch (e) { log('transcribe failed, spreading words by length: ' + e.message.slice(0, 120)); }
  s.timeline = alignScenes(s.gen.scenes, heard, s.voiceDur);
}
// Each script word gets the start time of the heard word at the same relative position (Whisper's
// spelling of Hindi is unreliable, its count and timing are good). Roman words follow their scene's span.
function alignScenes(scenes, heard, total) {
  const hiWords = scenes.map((x) => x.hi.split(/\s+/).filter(Boolean));
  const N = hiWords.reduce((a, w) => a + w.length, 0);
  const starts = [];
  if (heard.length >= N * 0.6) {
    // match by spoken-text position (share of characters), not word index: Whisper splits Hindi words differently,
    // and index matching drifted one scene to 16 s (2026-11-02)
    const all = hiWords.flat(), tot = all.reduce((a, w) => a + w.length, 0);
    const hc = []; let c = 0;
    for (const h of heard) { hc.push(c); c += h.w.length; }
    let acc = 0, j = 0;
    for (const w of all) {
      const target = (acc / tot) * c;
      while (j < heard.length - 1 && hc[j + 1] <= target) j++;
      starts.push(heard[j].s); acc += w.length;
    }
  } else {
    const all = hiWords.flat(), chars = all.reduce((a, w) => a + w.length + 1, 0); let t = 0.05;
    for (const w of all) { starts.push(t); t += (total - 0.7) * (w.length + 1) / chars; }
  }
  const lastEnd = heard.length ? heard[heard.length - 1].e : total - 0.6;
  let k = 0;
  const out = scenes.map((sc, i) => {
    const s0 = i === 0 ? 0 : starts[k]; k += hiWords[i].length;
    return { start: s0, roman: sc.roman.split(/\s+/).filter(Boolean), image: sc.image };
  });
  out.forEach((sc, i) => { sc.end = i < out.length - 1 ? out[i + 1].start : total; });
  // roman words: spread inside the scene's speech span by length
  out.forEach((sc, i) => {
    const speechEnd = i < out.length - 1 ? sc.end : Math.min(total, lastEnd + 0.1);
    const chars = sc.roman.reduce((a, w) => a + w.length + 1, 0);
    let t = sc.start + (i === 0 ? 0.05 : 0);
    const span = speechEnd - t;
    sc.words = sc.roman.map((w) => { const d = span * (w.length + 1) / Math.max(1, chars); const o = { w, s: t, e: t + d }; t += d; return o; });
  });
  return out;
}

// ---------- step 3: images (Cloudflare FLUX.2 klein 4B, Apache-2.0) ----------
async function cfImage(prompt, file) {
  const fd = new FormData();
  fd.append('prompt', `${prompt}. ${STYLE}`); fd.append('width', '1024'); fd.append('height', '1024');
  const r = await httpJson(`https://api.cloudflare.com/client/v4/accounts/${ENV.CLOUDFLARE_ACCOUNT_ID}/ai/run/${CF_MODEL}`,
    { method: 'POST', headers: { Authorization: 'Bearer ' + ENV.CLOUDFLARE_API_TOKEN }, body: fd }, 180000);
  const img = r.body?.result?.image;
  if (!r.ok || !img) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.body?.errors || r.body).slice(0, 200)}`);
  fs.writeFileSync(file, Buffer.from(img, 'base64'));
}
const softPrompt = (p) => p.replace(/\b(blood\w*|dead|death|die\w*|kill\w*|corpse|body|weapon|gun|knife|naked|nude|suicide|hang\w*|fight\w*|beat\w*|violence|violent|drunk|alcohol)\b/gi, '')
  .replace(/\s{2,}/g, ' ') + ', gentle and family-friendly';
async function stepImages(s) {
  const rd = runDir(s.runId);
  for (const [i, sc] of s.timeline.entries()) {
    sc.file = path.join(rd, `img${i}.png`);
    if (fs.existsSync(sc.file)) continue;
    // a prompt flagged by the safety filter (code 3030) is softened, then replaced by a calm generic scene
    // our doodle style always wins over style words Gemini adds ("realistic style" made FLUX flag scenes, 2026-11-01)
    const base = sc.image.replace(/,?\s*\b(hyper)?realistic( style)?|photo\w*|cinematic|named \w+/gi, '').trim();
    const prompts = [base, softPrompt(base), 'a stick-figure person sitting quietly under a tree at sunset, thoughtful mood'];
    for (let a = 0; ; a++) {
      try { await cfImage(prompts[Math.min(a, prompts.length - 1)], sc.file); break; } catch (e) {
        log(`image ${i} try ${a + 1}: ${e.message.slice(0, 160)}`);
        if (a >= 3) throw e; await sleep(4000);
      }
    }
  }
  log(`images OK: ${s.timeline.length}`);
}

// ---------- step 4: render (FFmpeg) ----------
const assTime = (t) => { const cs = Math.max(0, Math.round(t * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
const assEsc = (x) => String(x).replace(/[{}\\]/g, '').trim();
// FB / YouTube / Instagram logos + handles at the old watermark spot (asked 2026-11-02): a ready-made transparent
// strip (brand/handles.png, rebuilt by brand/src/handles.js when a handle changes), overlaid on reel and cover
const HANDLES_PNG = path.join(ROOT, 'brand', 'handles.png');
function buildAss(s) {
  const YEL = '&H0026D9FF&', WHT = '&H00FFFFFF&', total = s.voiceDur;
  const hl = (s.gen.hook.highlight || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hookLine = (l) => assEsc(l).split(/\s+/).map((w) => (w.toLowerCase().replace(/[^a-z0-9]/g, '') === hl && hl ? `{\\c${YEL}}${w}{\\c${WHT}}` : w)).join(' ');
  const ev = [`Dialogue: 1,${assTime(0)},${assTime(total)},Hook,,0,0,0,,${hookLine(s.gen.hook.line1)}\\N${hookLine(s.gen.hook.line2)}`];
  // subtitles: 2-4 words a line under the picture, the spoken word pops yellow and a bit bigger
  for (const sc of s.timeline) {
    const chunks = []; let cur = [];
    for (const w of sc.words) { cur.push(w); if (cur.length >= 3 || cur.map((x) => x.w).join(' ').length >= 18 || /[.?!,]$/.test(w.w)) { chunks.push(cur); cur = []; } }
    if (cur.length) chunks.push(cur);
    chunks.forEach((c) => c.forEach((w, wi) => {
      const en = wi < c.length - 1 ? c[wi + 1].s : c[c.length - 1].e;
      const txt = c.map((x, xi) => (xi === wi ? `{\\c${YEL}\\fscx112\\fscy112}${assEsc(x.w)}{\\c${WHT}\\fscx100\\fscy100}` : assEsc(x.w))).join(' ');
      ev.push(`Dialogue: 0,${assTime(w.s)},${assTime(Math.max(en, w.s + 0.06))},Sub,,0,0,0,,${txt}`);
    }));
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Poppins Black,66,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,70,70,${IMG_Y - 190},1
Style: Sub,Poppins Black,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,2,8,60,60,${IMG_Y + IMG + 50},1
Style: Mark,Poppins Black,26,&H30FFFFFF,&H30FFFFFF,&H50000000,&H00000000,0,0,0,0,100,100,1,0,1,2,0,2,0,0,${H - IMG_Y - IMG + 24},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev.join('\n')}
`;
}
function stepRender(s) {
  const rd = runDir(s.runId);
  fs.writeFileSync(path.join(rd, 'subs.ass'), buildAss(s), 'utf8');
  const tracks = fs.readdirSync(DIR.music).filter((f) => /\.mp3$/i.test(f));
  s.music = tracks.length ? tracks[Math.floor(Math.random() * tracks.length)] : null;
  // scene clips: whole frames only; image slowly pushes in, then cuts to the next
  const parts = [];
  let used = 0;
  s.timeline.forEach((sc, i) => {
    const endF = i < s.timeline.length - 1 ? Math.round(sc.end * FPS) : Math.ceil(s.voiceDur * FPS);
    const nf = Math.max(6, endF - used); used += nf;
    const clip = path.join(rd, `clip${i}.mp4`);
    const z = i % 2 ? `1.08-0.08*on/${nf}` : `1+0.08*on/${nf}`;
    run('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', sc.file, '-vf',
      `scale=${IMG * 2}:${IMG * 2},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${nf}:s=${IMG}x${IMG}:fps=${FPS},`
      + `pad=${W}:${H}:${IMG_X}:${IMG_Y}:black,format=yuv420p,setsar=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`,
      '-frames:v', String(nf), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', String(FPS), clip]);
    parts.push(clip);
  });
  const list = path.join(rd, 'clips.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const silent = path.join(rd, 'silent.mp4');
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);
  // relative paths for the subtitles filter (Windows drive colons break it)
  const rel = (p) => path.relative(process.cwd(), p).replace(/\\/g, '/');
  const out = path.join(DIR.output, `ZKS_${s.runId}.mp4`);
  const vol = ENV.MUSIC_VOLUME || '0.14';
  const args = ['-v', 'error', '-y', '-i', silent, '-i', path.join(rd, 'voice.wav')];
  let af;
  if (s.music) {
    args.push('-stream_loop', '-1', '-i', path.join(DIR.music, s.music));
    af = `[2:a]volume=${vol},afade=t=in:d=0.8,afade=t=out:st=${(s.voiceDur - 1.2).toFixed(2)}:d=1.2[m];[1:a][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false,afade=t=out:st=${(s.voiceDur - 0.35).toFixed(2)}:d=0.35[a]`;
  } else af = `[1:a]afade=t=out:st=${(s.voiceDur - 0.35).toFixed(2)}:d=0.35[a]`;
  const hIdx = s.music ? 3 : 2;
  args.push('-i', HANDLES_PNG);
  args.push('-filter_complex', `[0:v]subtitles='${rel(path.join(rd, 'subs.ass'))}':fontsdir='${rel(DIR.fonts)}'[sv];`
    + `[sv][${hIdx}:v]overlay=(W-w)/2:${IMG_Y + IMG - 104}[v];${af}`,
    '-map', '[v]', '-map', '[a]', '-t', s.voiceDur.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', out + '.tmp.mp4');
  const body = path.join(rd, 'body.mp4');
  args[args.length - 1] = body;
  run('ffmpeg', args);
  // thumbnail card: the reel opens on it for THUMB_SECS, and it is uploaded as the custom cover everywhere
  s.thumb = path.join(DIR.output, `ZKS_${s.runId}_thumb.png`);
  makeThumbnail(s, rd);
  run('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-t', String(THUMB_SECS), '-framerate', String(FPS), '-i', s.thumb,
    '-f', 'lavfi', '-t', String(THUMB_SECS), '-i', 'anullsrc=r=48000:cl=stereo', '-i', body, '-filter_complex',
    '[0:v]scale=1080:1920,setsar=1,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[tv];'
    + '[2:v]setsar=1[bv];[2:a]aformat=sample_rates=48000:channel_layouts=stereo[ba];[tv][1:a][bv][ba]concat=n=2:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out + '.tmp.mp4']);
  fs.renameSync(out + '.tmp.mp4', out);
  s.output = out;
  s.videoDur = dur(out);
  log(`render OK: ${path.basename(out)} (${s.videoDur.toFixed(1)} s incl. ${THUMB_SECS} s cover, music: ${s.music || 'none'})`);
}
const THUMB_SECS = 0.6;
// Cover: blurred scene-1 painting fills the frame, the sharp painting sits in the middle, the hook on top.
// Every word stays inside the 4:5 centre (y 285-1635) that Facebook/Instagram grids show: libass wraps the hook
// inside 90 px side margins and the font shrinks for long hooks, so text can never leave the frame.
function makeThumbnail(s, rd) {
  const img = s.timeline[0].file, h = s.gen.hook;
  const longest = Math.max(h.line1.length, h.line2.length);
  const fs1 = Math.max(70, Math.min(118, Math.floor(1700 / Math.max(10, longest))));
  const hl = (h.highlight || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const color = (w) => (hl && w.toLowerCase().replace(/[^a-z0-9]/g, '') === hl ? `{\\c&H0026D9FF&}${w}{\\c&H00FFFFFF&}` : w);
  const line = (l) => assEsc(l).split(/\s+/).map(color).join(' ');
  const ass = path.join(rd, 'thumb.ass');
  fs.writeFileSync(ass, `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: T,Poppins Black,${fs1},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,7,4,8,90,90,330,1
Style: M,Poppins Black,28,&H30FFFFFF,&H30FFFFFF,&H50000000,&H00000000,0,0,0,0,100,100,1,0,1,2,0,2,0,0,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,${line(h.line1)}\\N${line(h.line2)}
`, 'utf8');
  const rel = (p) => path.relative(process.cwd(), p).replace(/\\/g, '/');
  run('ffmpeg', ['-v', 'error', '-y', '-i', img, '-i', HANDLES_PNG, '-filter_complex',
    `[0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30,eq=brightness=-0.28[bg];`
    // painting y 680-1540, logo strip 1545-1635: both end inside the 4:5 grid crop (y 285-1635)
    + `[0]scale=860:860[fg];[bg][fg]overlay=(W-w)/2:680,subtitles='${rel(ass)}':fontsdir='${rel(DIR.fonts)}'[t];`
    + `[t][1:v]overlay=(W-w)/2:1545`,
    '-frames:v', '1', s.thumb]);
}

// ---------- step 5: post (Facebook Reels API) ----------
const caption = (g) => `${g.title}\n\n${g.caption}\n\n${[...new Set([...(g.hashtags || []), ...(ENV.FIXED_HASHTAGS || '').split(/\s+/)].filter((h) => /^#\S+$/.test(h)))].join(' ')}`;
// Publishing code and its safeguards come from the Infax pipeline (tested there 2026-10-27..31).
const GRAPH = 'https://graph.facebook.com/v26.0';
const IG_MAX = 44.5; // Instagram API reels fail above ~45 s (Infax lesson); Instagram is off for this page
const FB_MAX = 88; // Facebook Reels API takes 3-90 s; the story is never cut, only retold tighter
function need(...keys) { const m = keys.filter((k) => !ENV[k]); if (m.length) throw new Error('Missing setting: ' + m.join(', ')); }
// last check before anything goes public: never post a broken reel
function preflight(s) {
  if (!s.output || !fs.existsSync(s.output)) throw new Error('preflight: no rendered file');
  const p = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', s.output]));
  const v = p.streams.find((x) => x.codec_type === 'video'), a = p.streams.find((x) => x.codec_type === 'audio');
  const secs = parseFloat(p.format.duration);
  const bad = [];
  if (!v || v.width !== W || v.height !== H) bad.push('video not 1080x1920');
  if (!a) bad.push('no audio');
  if (!(secs >= 12 && secs <= 90)) bad.push(`length ${secs.toFixed(1)} s`);
  if (Math.abs(secs - s.voiceDur - THUMB_SECS) > 0.5) bad.push('video/voice length differ');
  if (!s.thumb || !fs.existsSync(s.thumb)) bad.push('missing thumbnail');
  if (!s.fromStock && s.timeline.some((sc) => !fs.existsSync(sc.file))) bad.push('missing image');
  if (bad.length) throw new Error('preflight: ' + bad.join(', '));
  return secs;
}
async function publishFacebook(s) {
  need('FB_PAGE_ID', 'FB_PAGE_ACCESS_TOKEN');
  const tok = ENV.FB_PAGE_ACCESS_TOKEN, page = ENV.FB_PAGE_ID;
  const start = await httpJson(`${GRAPH}/${page}/video_reels`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'start', access_token: tok }) }, 60000);
  if (!start.ok || !start.body.video_id) throw new Error('FB start failed: ' + JSON.stringify(start.body).slice(0, 300));
  const videoId = start.body.video_id, size = fs.statSync(s.output).size;
  const up = await httpJson(`https://rupload.facebook.com/video-upload/v26.0/${videoId}`, { method: 'POST', body: fs.readFileSync(s.output),
    headers: { Authorization: 'OAuth ' + tok, offset: '0', file_size: String(size), 'Content-Type': 'application/octet-stream' } }, 600000);
  if (!up.ok || !up.body.success) throw new Error('FB upload failed: ' + JSON.stringify(up.body).slice(0, 300));
  const fin = await httpJson(`${GRAPH}/${page}/video_reels`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', title: s.gen.title.slice(0, 100), description: caption(s.gen), is_ai_generated: true, access_token: tok }) }, 120000);
  // from here the reel is public: nothing below may throw into a retry (no double posts)
  if (!fin.ok || !fin.body.success) throw Object.assign(new Error('FB publish failed: ' + JSON.stringify(fin.body).slice(0, 300)), { maybePosted: true });
  let link = null;
  for (let k = 0; k < 60 && !link; k++) {
    await sleep(10000);
    const st = await httpJson(`${GRAPH}/${videoId}?fields=status,permalink_url&access_token=${encodeURIComponent(tok)}`, {}, 30000);
    const vs = st.body.status || {};
    if (vs.video_status === 'error') { log('FB processing error: ' + JSON.stringify(vs).slice(0, 200)); break; }
    if (vs.publishing_phase?.status === 'complete' || vs.video_status === 'ready') link = st.body.permalink_url;
  }
  // custom cover (the reel is already public: a failure here is only logged)
  const fd = new FormData();
  fd.append('source', new Blob([fs.readFileSync(s.thumb)], { type: 'image/png' }), 'thumb.png');
  fd.append('is_preferred', 'true'); fd.append('access_token', tok);
  const th = await httpJson(`${GRAPH}/${videoId}/thumbnails`, { method: 'POST', body: fd }, 120000);
  log(th.ok ? 'facebook thumbnail set' : 'facebook thumbnail failed: ' + JSON.stringify(th.body).slice(0, 160));
  return link ? (link.startsWith('http') ? link : 'https://www.facebook.com' + link) : `https://www.facebook.com/reel/${videoId}`;
}
// Instagram version: the API fails above ~44.5 s, but the story must stay whole: first speed up (max 1.15×, pitch
// kept); if that is not enough, drop the longest middle scenes (never scene 1 or the last two: twist + lesson).
function makeInstagramVersion(s) {
  const total = s.videoDur;
  if (total <= IG_MAX) return s.output;
  const MAX_SPEED = 1.15, off = THUMB_SECS;
  const cut = [];
  let keep = total;
  const middle = s.timeline.map((sc, i) => ({ i, len: sc.end - sc.start })).slice(1, -2).sort((a, b) => b.len - a.len);
  // cut as little as possible: the shortest single middle scene that is enough, else the longest and repeat
  while (keep / MAX_SPEED > IG_MAX - 0.5 && middle.length) {
    const enough = middle.filter((m) => (keep - m.len) / MAX_SPEED <= IG_MAX - 0.5).sort((a, b) => a.len - b.len)[0];
    const m = enough || middle[0];
    middle.splice(middle.indexOf(m), 1); cut.push(m.i); keep -= m.len;
  }
  const speed = Math.max(1, keep / (IG_MAX - 0.5));
  // segments to keep, in video time
  const segs = []; let t = 0;
  for (const i of cut.sort((a, b) => a - b)) { const sc = s.timeline[i]; segs.push([t, sc.start + off]); t = sc.end + off; }
  segs.push([t, total]);
  const parts = segs.map(([a, b], k) => `[0:v]trim=${a.toFixed(3)}:${b.toFixed(3)},setpts=PTS-STARTPTS[v${k}];[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS[a${k}];`).join('');
  const cat = segs.map((_, k) => `[v${k}][a${k}]`).join('') + `concat=n=${segs.length}:v=1:a=1[cv][ca];`
    + `[cv]setpts=PTS/${speed.toFixed(4)}[v];[ca]atempo=${speed.toFixed(4)}[a]`;
  const out = s.output.replace(/\.mp4$/, '_ig.mp4');
  run('ffmpeg', ['-v', 'error', '-y', '-i', s.output, '-filter_complex', parts + cat, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart', out + '.tmp.mp4']);
  fs.renameSync(out + '.tmp.mp4', out);
  const d = dur(out);
  log(`instagram version: ${d.toFixed(1)} s (speed ${speed.toFixed(2)}×, scenes cut: ${cut.length ? cut.join(',') : 'none'})`);
  if (d > IG_MAX) throw new Error(`instagram version still ${d.toFixed(1)} s`);
  return out;
}
async function instagramOnce(s, file) {
  const tok = ENV.FB_PAGE_ACCESS_TOKEN, ig = ENV.IG_USER_ID;
  // cover = the thumbnail card the reel opens on (frame at 0.2 s)
  const c = await httpJson(`${GRAPH}/${ig}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'REELS', upload_type: 'resumable', caption: caption(s.gen).slice(0, 2200), share_to_feed: true, thumb_offset: 200, access_token: tok }) }, 60000);
  if (!c.ok || !c.body.id) throw new Error('IG container failed: ' + JSON.stringify(c.body).slice(0, 300));
  const id = c.body.id;
  const up = await httpJson(`https://rupload.facebook.com/ig-api-upload/v26.0/${id}`, { method: 'POST', body: fs.readFileSync(file),
    headers: { Authorization: 'OAuth ' + tok, offset: '0', file_size: String(fs.statSync(file).size) } }, 600000);
  if (!up.ok || !up.body.success) throw new Error('IG upload failed: ' + JSON.stringify(up.body).slice(0, 300));
  let st = '';
  for (let k = 0; k < 40 && st !== 'FINISHED'; k++) {
    await sleep(15000);
    st = (await httpJson(`${GRAPH}/${id}?fields=status_code&access_token=${encodeURIComponent(tok)}`, {}, 30000)).body.status_code || '';
    if (st === 'ERROR' || st === 'EXPIRED') throw new Error('IG processing ' + st);
  }
  if (st !== 'FINISHED') throw new Error('IG processing did not finish in 10 min');
  const pub = await httpJson(`${GRAPH}/${ig}/media_publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: id, access_token: tok }) }, 120000);
  if (!pub.ok || !pub.body.id) throw Object.assign(new Error('IG publish failed: ' + JSON.stringify(pub.body).slice(0, 300)), { maybePosted: true });
  const pl = (await httpJson(`${GRAPH}/${pub.body.id}?fields=permalink&access_token=${encodeURIComponent(tok)}`, {}, 30000)).body.permalink;
  return pl || 'https://www.instagram.com/';
}
async function publishInstagram(s) {
  need('FB_PAGE_ACCESS_TOKEN', 'IG_USER_ID');
  const file = makeInstagramVersion(s);
  // IG's upload server fails at random: up to 4 tries with a fresh container, never after a publish call
  for (let a = 1; ; a++) {
    try { return await instagramOnce(s, file); } catch (e) {
      if (a >= 4 || e.maybePosted || !/IG (container|upload|processing)/.test(e.message)) throw e;
      log(`instagram try ${a} failed (${e.message.slice(0, 90)}), retry in ${a * 45} s`); await sleep(a * 45000);
    }
  }
}
// ---------- YouTube Shorts (code from Infax, live there since 2026-10-28) ----------
async function youtubeToken() {
  need('YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN');
  const r = await httpJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ENV.YT_CLIENT_ID, client_secret: ENV.YT_CLIENT_SECRET, refresh_token: ENV.YT_REFRESH_TOKEN, grant_type: 'refresh_token' }) }, 30000);
  if (!r.ok || !r.body.access_token) throw new Error('YouTube token refresh failed: ' + JSON.stringify(r.body).slice(0, 200));
  return r.body.access_token;
}
async function publishYouTube(s) {
  const tok = await youtubeToken();
  const g = s.gen, tags = (g.hashtags || []).map((h) => h.replace(/^#/, ''));
  const meta = {
    snippet: { title: g.title.replace(/[<>]/g, '').slice(0, 100), description: `${g.caption}\n\n${(g.hashtags || []).join(' ')} #Shorts`.replace(/[<>]/g, '').slice(0, 4900),
      tags: tags.slice(0, 15), categoryId: ENV.YT_CATEGORY || '22', defaultLanguage: 'hi', defaultAudioLanguage: 'hi' },
    status: { privacyStatus: ENV.YT_PRIVACY || 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  };
  const size = fs.statSync(s.output).size;
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', { method: 'POST', body: JSON.stringify(meta),
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) },
    signal: AbortSignal.timeout(60000) });
  const loc = init.headers.get('location');
  if (!init.ok || !loc) throw new Error(`YouTube upload start failed: HTTP ${init.status} ${(await init.text()).slice(0, 200)}`);
  const up = await httpJson(loc, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: fs.readFileSync(s.output) }, 600000);
  if (!up.ok || !up.body.id) throw new Error('YouTube upload failed: ' + JSON.stringify(up.body).slice(0, 200));
  // custom thumbnail: needs a phone-verified channel; until then YouTube refuses it and the Short keeps its first
  // frame, which is the same thumbnail card anyway
  const th = await httpJson(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${up.body.id}`,
    { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'image/png' }, body: fs.readFileSync(s.thumb) }, 120000);
  log(th.ok ? 'youtube thumbnail set' : `youtube thumbnail not set (HTTP ${th.status}; verify the channel by phone to allow it)`);
  return `https://youtube.com/shorts/${up.body.id}`;
}
// YT_HOURS: IST hours whose run also goes to YouTube, or "all" (my choice 2026-11-02: both daily reels)
const ytSlot = () => /^all$/i.test(ENV.YT_HOURS || '') || (ENV.YT_HOURS || '18').split(',').map(Number).includes(new Date(Date.now() + 5.5 * 3600e3).getUTCHours());
async function stepPost(s) {
  const secs = preflight(s);
  if (!/^true$/i.test(ENV.POST_ENABLED || '')) { log('POST_ENABLED is not true → not posted (dry run)'); s.posted = { fb: 'dry-run' }; return; }
  s.posted = s.posted || {};
  if (!s.posted.fb) { s.posted.fb = await publishFacebook(s); saveState(s); log('facebook posted: ' + s.posted.fb); }
  // Instagram is a separate step: its failure never blocks or repeats the Facebook post (new features default OFF)
  if (/^true$/i.test(ENV.IG_ENABLED || '') && !s.posted.ig) {
    try { s.posted.ig = await publishInstagram(s); log('instagram posted: ' + s.posted.ig); }
    catch (e) { s.posted.ig = '❌ ' + e.message.slice(0, 120); log('instagram failed: ' + e.message); }
  }
  if (/^true$/i.test(ENV.YT_ENABLED || '') && !s.posted.yt && (ytSlot() || process.env.FORCE_YT === 'true')) {
    try { s.posted.yt = await publishYouTube(s); log('youtube posted: ' + s.posted.yt); }
    catch (e) { s.posted.yt = '❌ ' + e.message.slice(0, 120); log('youtube failed: ' + e.message); }
  }
  fs.appendFileSync(path.join(DIR.logs, 'posts.csv'), `"${s.runId}","${s.gen.title.replace(/"/g, '""')}","${s.posted.fb}","${s.posted.yt || ''}"\n`, 'utf8');
}

// ---------- main ----------
async function make(topic) {
  for (const d of Object.values(DIR)) fs.mkdirSync(d, { recursive: true });
  const s = { runId: istStamp().id, date: istStamp().date };
  RUN = s.runId; fs.mkdirSync(runDir(s.runId), { recursive: true });
  // the whole story must fit Facebook's 90 s limit: a too-long one is retold tighter (still complete), max 2 times
  // Instagram gets its own shortened copy, so the story only has to fit Facebook (minus the cover card)
  const maxSecs = FB_MAX - THUMB_SECS;
  for (let k = 0; ; k++) {
    await stepScript(s, topic, k, maxSecs); saveState(s);
    await stepVoice(s); saveState(s);
    if (s.voiceDur <= maxSecs) break;
    if (k >= 2) throw new Error(`story still ${s.voiceDur.toFixed(1)} s after 2 rewrites`);
    log(`voice ${s.voiceDur.toFixed(1)} s is over ${maxSecs} s → retelling tighter`);
  }
  await stepImages(s); saveState(s);
  stepRender(s); saveState(s);
  fs.appendFileSync(path.join(DIR.logs, 'used-topics.txt'), s.gen.topic + '\n', 'utf8');
  fs.writeFileSync(path.join(DIR.output, `ZKS_${s.runId}.txt`), caption(s.gen), 'utf8');
  return s;
}
// ---------- Google Drive stock (asked 2026-11-02) ----------
// Reels are made ahead (only with the Charon voice) and kept in Drive, so a busy Gemini never forces another voice:
// "stock" tops the Drive folder up to STOCK_TARGET reels; "publish" posts the oldest one and deletes it from Drive.
const drive = require('./drive.js');
const STOCK_FOLDER = 'Zindagi Ka Sach Stock';
const stockKind = (n) => (n.endsWith('_thumb.png') ? 'thumb' : n.endsWith('.json') ? 'state' : n.endsWith('.mp4') ? 'video' : '');
async function stockItems(fid) {
  const byRun = {};
  for (const f of await drive.list(fid)) {
    const id = f.appProperties?.runId; const k = stockKind(f.name);
    if (id && k) (byRun[id] = byRun[id] || { runId: id })[k] = f;
  }
  return Object.values(byRun).filter((x) => x.video && x.thumb && x.state).sort((a, b) => a.runId.localeCompare(b.runId));
}
async function stock() {
  need('DRIVE_REFRESH_TOKEN'); drive.init(ENV);
  const fid = await drive.folder(STOCK_FOLDER);
  const target = parseInt(ENV.STOCK_TARGET || '5', 10), perRun = parseInt(ENV.STOCK_PER_RUN || '3', 10);
  let have = (await stockItems(fid)).length;
  log(`stock: ${have}/${target} reels in Drive`);
  for (let made = 0; have < target && made < perRun; made++) {
    const s = await make(); // throws (nothing stored) when Charon is unavailable
    preflight(s);
    const p = { runId: s.runId };
    await drive.upload(s.output, path.basename(s.output), fid, 'video/mp4', p);
    await drive.upload(s.thumb, path.basename(s.thumb), fid, 'image/png', p);
    const st = path.join(runDir(s.runId), 'state.json');
    await drive.upload(st, `ZKS_${s.runId}.json`, fid, 'application/json', p);
    have++; log(`stock: stored ${s.runId} (${have}/${target})`);
  }
}
async function publishFromStock() {
  need('DRIVE_REFRESH_TOKEN'); drive.init(ENV);
  const fid = await drive.folder(STOCK_FOLDER);
  const items = await stockItems(fid);
  if (!items.length) { log('stock empty → making a fresh reel now'); const s = await make(); await stepPost(s); saveState(s); return; }
  const it = items[0];
  RUN = it.runId; fs.mkdirSync(runDir(it.runId), { recursive: true }); fs.mkdirSync(DIR.output, { recursive: true });
  const st = path.join(runDir(it.runId), 'state.json');
  await drive.download(it.state.id, st);
  const s = loadState(it.runId);
  s.output = path.join(DIR.output, it.video.name); s.thumb = path.join(DIR.output, it.thumb.name); s.fromStock = true;
  await drive.download(it.video.id, s.output); await drive.download(it.thumb.id, s.thumb);
  log(`publish from stock: ${it.runId} (${items.length - 1} left)`);
  await stepPost(s); saveState(s);
  // delete from Drive only once Facebook has it (the main post); IG/YT failures are logged, never re-posted
  if (s.posted?.fb && s.posted.fb !== 'dry-run') for (const f of [it.video, it.thumb, it.state]) await drive.remove(f.id);
}
(async () => {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'stock') await stock();
    else if (cmd === 'publish') await publishFromStock();
    else if (cmd === 'make') { const s = await make(arg); console.log(JSON.stringify({ runId: s.runId, output: s.output })); }
    else if (cmd === 'resume') { // finish a failed run from its images (script + voice kept)
      RUN = arg; const s = loadState(arg); await stepImages(s); saveState(s); stepRender(s); saveState(s);
      fs.appendFileSync(path.join(DIR.logs, 'used-topics.txt'), s.gen.topic + '\n', 'utf8');
      fs.writeFileSync(path.join(DIR.output, `ZKS_${s.runId}.txt`), caption(s.gen), 'utf8');
      console.log(JSON.stringify({ runId: s.runId, output: s.output }));
    } else if (cmd === 'igtest') { // build only the Instagram copy of a rendered run (no upload)
      RUN = arg; const s = loadState(arg); console.log(makeInstagramVersion(s));
    } else if (cmd === 'igpost') { // publish one rendered run to Instagram only (first real-path test)
      RUN = arg; const s = loadState(arg); preflight(s); console.log('instagram: ' + await publishInstagram(s));
    } else if (cmd === 'yttest') { // private test upload of a rendered run
      RUN = arg; const s = loadState(arg); preflight(s); ENV.YT_PRIVACY = 'private';
      console.log('youtube (private): ' + await publishYouTube(s));
    } else if (cmd === 'post') { RUN = arg; const s = loadState(arg); await stepPost(s); saveState(s); }
    else if (cmd === 'all') { const s = await make(arg); await stepPost(s); saveState(s); }
    else { console.error('usage: node zks.js make [topic] | post <runId> | all'); process.exit(2); }
  } catch (e) { log('FAILED: ' + e.message); process.exit(1); }
})();
