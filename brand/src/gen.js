// one-off: brand artwork with the same model + style as the reels
const fs = require('fs'), path = require('path');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '../../.env'), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const STYLE = 'soft hand-drawn storybook illustration, thin black ink outlines, warm cream paper background, muted earthy watercolor fills, gentle shading, minimal clean composition, absolutely no text, letters or watermark';
const jobs = {
  mascot: 'a friendly stick-figure storyteller with a round head, dot eyes and a small warm smile, wearing a mustard yellow kurta, holding an open glowing book, centered portrait, plain cream background, lots of empty space around',
  scene_left: 'a stick-figure old man in a white kurta sitting under a big banyan tree telling a story to two small stick-figure children, village path, warm evening light',
  scene_right: 'a stick-figure young man in a blue shirt walking on a long winding road toward a rising sun on the horizon, a few birds, hopeful mood, wide open fields',
};
(async () => {
  for (const [name, prompt] of Object.entries(jobs)) {
    const fd = new FormData(); fd.append('prompt', `${prompt}. ${STYLE}`); fd.append('width', '1024'); fd.append('height', '1024');
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`, { method: 'POST', headers: { Authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN }, body: fd });
    const j = await r.json();
    if (!j.result?.image) { console.log(name, 'FAILED', JSON.stringify(j.errors).slice(0, 150)); continue; }
    fs.writeFileSync(path.join(__dirname, name + '.png'), Buffer.from(j.result.image, 'base64')); console.log(name, 'ok');
  }
})();
