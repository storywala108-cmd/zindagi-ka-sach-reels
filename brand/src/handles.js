// Builds brand/handles.png (transparent): FB / YouTube / Instagram logos (Simple Icons, CC0) + our handles.
// Run again only when a handle changes: node brand/src/handles.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const dir = __dirname;
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const svg = (n) => fs.readFileSync(path.join(dir, `${n}.svg`), 'utf8').replace(/<title>.*?<\/title>/, '');
const page = fs.readFileSync(path.join(dir, 'handles.html'), 'utf8')
  .replace('FB_SVG', svg('facebook')).replace('YT_SVG', svg('youtube')).replace('IG_SVG', svg('instagram'));
const tmp = path.join(dir, '_handles.html');
fs.writeFileSync(tmp, page);
const out = path.resolve(dir, '..', 'handles.png');
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
  '--allow-file-access-from-files', '--window-size=1000,96', `--screenshot=${out}`, '--virtual-time-budget=2000', pathToFileURL(tmp).href], { stdio: 'ignore' });
fs.unlinkSync(tmp);
console.log(fs.existsSync(out) ? 'ok ' + out : 'FAILED');
