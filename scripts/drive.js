// Google Drive stock of ready reels (scope drive.file: the app only sees files it made itself).
// Ported from Ink & Crowns Automation/scripts/drive.js (tested there). Folder: "Zindagi Ka Sach Stock".
'use strict';
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const API = 'https://www.googleapis.com/drive/v3';
let ENV = {};
let cached;
const init = (env) => { ENV = env; };
async function token() {
  if (cached && cached.exp > Date.now() + 60000) return cached.t;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ENV.YT_CLIENT_ID, client_secret: ENV.YT_CLIENT_SECRET,
      refresh_token: ENV.DRIVE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Drive token refresh failed: ' + JSON.stringify(j).slice(0, 160));
  cached = { t: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.t;
}
const H = async (extra = {}) => ({ authorization: `Bearer ${await token()}`, ...extra });
const q = (s) => encodeURIComponent(s);
async function json(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(120000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`drive ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

async function folder(name) {
  const f = await json(`${API}/files?q=${q(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)`, { headers: await H() });
  if (f.files[0]) return f.files[0].id;
  const c = await json(`${API}/files?fields=id`, { method: 'POST', headers: await H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }) });
  return c.id;
}
// reels are small (< 50 MB): one resumable PUT, retried
async function upload(localPath, name, parentId, mime, appProperties = {}) {
  const size = fs.statSync(localPath).size;
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST', headers: await H({ 'content-type': 'application/json', 'x-upload-content-type': mime, 'x-upload-content-length': String(size) }),
    body: JSON.stringify({ name, parents: [parentId], appProperties }),
  });
  const loc = start.headers.get('location');
  if (!loc) throw new Error(`drive upload start ${start.status}: ${(await start.text()).slice(0, 200)}`);
  const body = fs.readFileSync(localPath);
  for (let t = 0; t < 4; t++) {
    const r = await fetch(loc, { method: 'PUT', body, signal: AbortSignal.timeout(600000) }).catch((e) => ({ status: 0, e }));
    if (r.status === 200 || r.status === 201) return (await r.json()).id;
    await new Promise((x) => setTimeout(x, 5000 * (t + 1)));
  }
  throw new Error('drive upload failed: ' + name);
}
async function list(parentId) {
  const r = await json(`${API}/files?q=${q(`'${parentId}' in parents and trashed=false`)}&orderBy=createdTime&pageSize=200`
    + '&fields=files(id,name,size,createdTime,appProperties)', { headers: await H() });
  return r.files;
}
async function download(fileId, localPath) {
  const r = await fetch(`${API}/files/${fileId}?alt=media`, { headers: await H() });
  if (!r.ok) throw new Error(`drive download ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(localPath + '.tmp'));
  fs.renameSync(localPath + '.tmp', localPath);
}
// permanent delete (trash still counts against the 15 GB); only after the reel is published
async function remove(fileId) {
  const r = await fetch(`${API}/files/${fileId}`, { method: 'DELETE', headers: await H() });
  if (!r.ok && r.status !== 404) throw new Error(`drive delete ${r.status}`);
}
module.exports = { init, folder, upload, list, download, remove };
