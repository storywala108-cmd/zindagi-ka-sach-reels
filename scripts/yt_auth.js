// One-time: connect my YouTube channel (or Google Drive). Opens Google's consent page; after "Allow" the refresh
// token is written straight into .env (never printed). Needs YT_CLIENT_ID + YT_CLIENT_SECRET (a "Desktop app" OAuth
// client) in .env. Google refuses YouTube + Drive scopes in one consent, so Drive gets its own token.
// Usage: node scripts/yt_auth.js          → YT_REFRESH_TOKEN
//        node scripts/yt_auth.js drive    → DRIVE_REFRESH_TOKEN (drive.file = only files this app creates)
const http = require('http');
const fs = require('fs');
const path = require('path');

const DRIVE = process.argv[2] === 'drive';
const KEY = DRIVE ? 'DRIVE_REFRESH_TOKEN' : 'YT_REFRESH_TOKEN';
const envFile = path.resolve(__dirname, '..', '.env');
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
if (!env.YT_CLIENT_ID || !env.YT_CLIENT_SECRET) { console.log('YT_CLIENT_ID / YT_CLIENT_SECRET missing in .env'); process.exit(1); }

const PORT = 8765, redirect = `http://127.0.0.1:${PORT}`;
const consent = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: env.YT_CLIENT_ID, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent',
  login_hint: 'rbloga20@gmail.com',
  scope: DRIVE ? 'https://www.googleapis.com/auth/drive.file'
    : 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
});

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get('code');
  if (!code) { res.end('waiting for Google...'); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
    code, client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }) });
  const j = await r.json();
  if (!j.refresh_token) { res.end('Failed: ' + (j.error_description || j.error)); console.log('FAILED:', j.error); server.close(); return; }
  let t = fs.readFileSync(envFile, 'utf8');
  const re = new RegExp(`^${KEY}=.*$`, 'm');
  t = re.test(t) ? t.replace(re, `${KEY}=${j.refresh_token}`) : t.trimEnd() + `\r\n${KEY}=${j.refresh_token}\r\n`;
  fs.writeFileSync(envFile, t, 'utf8');
  const who = DRIVE
    ? (await (await fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: { Authorization: 'Bearer ' + j.access_token } })).json()).user?.emailAddress
    : (await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: 'Bearer ' + j.access_token } })).json()).items?.[0]?.snippet?.title;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<h2>✅ Connected: ${who || '(unknown)'}</h2><p>You can close this tab.</p>`);
  console.log(`connected ${DRIVE ? 'drive' : 'channel'}:`, who);
  server.close();
});
server.listen(PORT, '127.0.0.1', () => console.log('CONSENT_URL ' + consent));
