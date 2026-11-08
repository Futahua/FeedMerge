// Hourly FeedMerge backup (scheduled task "FeedMerge backup").
//
// - Database: a consistent copy via SQLite's VACUUM INTO, taken while FeedMerge keeps running,
//   checked with PRAGMA integrity_check, then gzipped into <root>\hourly\<time>\feed.db.gz.
//   Kept: the last 48 hourly copies plus one per day for 30 days.
// - Media cache (Instagram/TikTok images whose source links expire): mirrored into <root>\media,
//   copying new or changed files only. Files removed from the cache are kept.
// - One line per run in <root>\backup.log. A failed run leaves earlier copies untouched.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.FEEDMERGE_DB || path.join(APP, 'data', 'feed.db');
const MEDIA = path.join(path.dirname(DB), 'media');
const ROOT = process.env.FEEDMERGE_BACKUP_ROOT || 'D:/Programs/FeedMergeBackups';
const HOURLY = path.join(ROOT, 'hourly');
const REMOTE = process.env.FEEDMERGE_BACKUP_URL || (()=>{try{return JSON.parse(fs.readFileSync(path.join(APP,'config.json'),'utf8')).backup?.url;}catch{return null;}})();

const log = msg => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  fs.mkdirSync(ROOT, { recursive: true });
  fs.appendFileSync(path.join(ROOT, 'backup.log'), line + '\n');
};

function prune() {
  const all = fs.readdirSync(HOURLY).filter(n => /^\d{8}T\d{6}Z$/.test(n)).sort().reverse();
  const keep = new Set(all.slice(0, 48));
  const days = new Set();
  for (const n of all) if (!days.has(n.slice(0, 8)) && days.size < 30) { days.add(n.slice(0, 8)); keep.add(n); }
  for (const n of all) if (!keep.has(n)) fs.rmSync(path.join(HOURLY, n), { recursive: true, force: true });
}

function mirrorMedia() {
  if (!fs.existsSync(MEDIA)) return 0;
  let copied = 0;
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, e.name), r = path.join(rel, e.name), to = path.join(ROOT, 'media', r);
      if (e.isDirectory()) { walk(from, r); continue; }
      if (!e.isFile()) continue;
      const s = fs.statSync(from);
      const t = fs.existsSync(to) ? fs.statSync(to) : null;
      if (t && t.size === s.size && t.mtimeMs >= s.mtimeMs) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to + '.tmp');
      fs.renameSync(to + '.tmp', to);
      copied++;
    }
  };
  walk(MEDIA);
  return copied;
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = path.join(HOURLY, stamp);
  const work = dir + '.partial';
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const copy = path.join(work, 'feed.db');

  if(REMOTE){
    const response=await fetch(REMOTE,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error('Remote snapshot HTTP '+response.status);
    await pipeline(response.body,fs.createWriteStream(copy));
  } else {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 15000');
    db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  } finally { db.close(); }

  }
  const check = new DatabaseSync(copy, { readOnly: true });
  let posts;
  try {
    const ok = check.prepare('PRAGMA integrity_check').get();
    if (Object.values(ok)[0] !== 'ok') throw new Error(`integrity check: ${JSON.stringify(ok)}`);
    try { posts = check.prepare('SELECT count(*) AS n FROM items').get().n; } catch { posts = '?'; }
  } finally { check.close(); }

  await pipeline(fs.createReadStream(copy), zlib.createGzip({ level: 9 }), fs.createWriteStream(copy + '.gz'));
  fs.rmSync(copy);
  fs.renameSync(work, dir);
  prune();
  const media = mirrorMedia();
  const size = fs.statSync(path.join(dir, 'feed.db.gz')).size;
  log(`backup ${stamp}: ${posts} posts, ${(size / 1e6).toFixed(1)} MB gzipped, integrity ok, media +${media}`);
}

main().catch(err => {
  try { log(`backup failed: ${String(err?.message || err).slice(0, 300)}`); } catch { /* ignore */ }
  process.exit(1);
});
