// FeedMerge local store: receives captures from the browser extension, keeps every raw
// capture, rebuilds normalized items from them, and serves the merged-feed viewer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { parseCapture } from './parsers.mjs';
import { startTagger } from './ai.mjs';
import { initSources, resolveSource, startPoller } from './sources.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
const CONFIG = path.join(DIR, 'config.json');
fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(CONFIG)) fs.copyFileSync(path.join(DIR, 'config.example.json'), CONFIG);

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}
const PORT = Number(process.env.FEEDMERGE_PORT || readConfig().port || 4747);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const LOG = process.env.FEEDMERGE_LOG || path.join(DATA, 'server.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5e6) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, line);
  } catch {}
  if (process.stdout.isTTY) process.stdout.write(line);
}

const db = new DatabaseSync(process.env.FEEDMERGE_DB || path.join(DATA, 'feed.db'));
db.exec(`
pragma journal_mode = wal;
create table if not exists raw (id integer primary key, platform text, kind text, url text, page_url text, captured_at integer, body blob);
create table if not exists items (
  id text primary key, platform text, native_id text, context text, author text, author_name text,
  title text, text text, url text, media text, published_at integer, first_seen integer, last_seen integer,
  seen_count integer default 1, metrics text, flags text, ai_topics text, ai_story text, ai_done integer default 0, saved integer default 0);
create index if not exists items_first on items(first_seen);
create index if not exists items_pub on items(published_at);
create index if not exists items_ai on items(ai_done);
create virtual table if not exists items_fts using fts5(author, title, text);
`);

initSources(db);
let poller = null;

const q = {
  rawIns: db.prepare('insert into raw(platform, kind, url, page_url, captured_at, body) values (?, ?, ?, ?, ?, ?)'),
  get: db.prepare('select rowid, text from items where id = ?'),
  ins: db.prepare(`insert into items(id, platform, native_id, context, author, author_name, title, text, url, media, published_at, first_seen, last_seen, metrics, flags)
                   values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  upd: db.prepare(`update items set last_seen = max(last_seen, ?), seen_count = seen_count + 1, metrics = coalesce(?, metrics), text = ?,
                   media = case when media is null or media = '[]' then ? else media end, published_at = coalesce(published_at, ?) where id = ?`),
  ftsIns: db.prepare('insert into items_fts(rowid, author, title, text) values (?, ?, ?, ?)'),
  ftsDel: db.prepare('delete from items_fts where rowid = ?'),
};

const s = v => (v == null ? null : String(v));
const j = v => (v == null ? null : JSON.stringify(v));

function ingest(cap, keepRaw = true) {
  const t = Number(cap.capturedAt) || Date.now();
  const text = typeof cap.payload === 'string' ? cap.payload : JSON.stringify(cap.payload ?? null);
  if (keepRaw) q.rawIns.run(s(cap.platform), s(cap.kind), s(cap.url) || '', s(cap.pageUrl) || '', t, gzipSync(text));
  let items = [];
  try { items = parseCapture({ platform: cap.platform, kind: cap.kind, url: cap.url, pageUrl: cap.pageUrl, capturedAt: t, text }); }
  catch (e) { log('parse error', cap.platform, cap.url, e.message); }
  const seen = new Set();
  let added = 0;
  db.exec('begin');
  try {
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      const ex = q.get.get(it.id);
      if (!ex) {
        const r = q.ins.run(it.id, it.platform, s(it.nativeId), s(it.context), s(it.author), s(it.authorName), s(it.title), s(it.text), s(it.url),
          j(it.media || []), it.publishedAt ?? null, t, t, j(it.metrics || {}), j(it.flags || {}));
        q.ftsIns.run(r.lastInsertRowid, s(it.author) || '', s(it.title) || '', s(it.text) || '');
        added++;
      } else {
        const better = (it.text || '').length > (ex.text || '').length;
        q.upd.run(t, j(it.metrics), better ? it.text : ex.text, j(it.media || []), it.publishedAt ?? null, it.id);
        if (better) { q.ftsDel.run(ex.rowid); q.ftsIns.run(ex.rowid, s(it.author) || '', s(it.title) || '', it.text); }
      }
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  return { parsed: seen.size, added };
}

// Rebuild every item from stored raw captures, keeping AI labels and saves.
function reparse() {
  const keep = db.prepare('select id, ai_topics, ai_story, ai_done, saved from items').all();
  db.exec('delete from items; delete from items_fts;');
  const ids = db.prepare('select id from raw order by id').all();
  const one = db.prepare('select * from raw where id = ?');
  let n = 0;
  for (const { id } of ids) {
    const r = one.get(id);
    ingest({ platform: r.platform, kind: r.kind, url: r.url, pageUrl: r.page_url, capturedAt: r.captured_at, payload: gunzipSync(r.body).toString('utf8') }, false);
    n++;
  }
  const restore = db.prepare('update items set ai_topics = ?, ai_story = ?, ai_done = ?, saved = ? where id = ?');
  db.exec('begin');
  for (const k of keep) restore.run(k.ai_topics, k.ai_story, k.ai_done, k.saved, k.id);
  db.exec('commit');
  return { captures: n, items: db.prepare('select count(*) n from items').get().n };
}

function rowOut(r) {
  const p = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return {
    id: r.id, platform: r.platform, context: r.context, author: r.author, authorName: r.author_name, title: r.title, text: r.text,
    url: r.url, media: p(r.media) || [], publishedAt: r.published_at, firstSeen: r.first_seen, lastSeen: r.last_seen,
    seenCount: r.seen_count, metrics: p(r.metrics) || {}, flags: p(r.flags) || {}, topics: p(r.ai_topics) || [], story: r.ai_story, saved: !!r.saved,
  };
}

function ftsQuery(text) {
  return text.split(/\s+/).filter(Boolean).map(w => `"${w.replace(/"/g, '""')}"*`).join(' ');
}

function listItems(p) {
  const where = [];
  const args = [];
  const platforms = (p.get('platform') || '').split(',').filter(Boolean);
  if (platforms.length) { where.push(`platform in (${platforms.map(() => '?').join(',')})`); args.push(...platforms); }
  if (p.get('context')) { where.push('context = ?'); args.push(p.get('context')); }
  if (p.get('topic')) { where.push('exists (select 1 from json_each(items.ai_topics) where value = ?)'); args.push(p.get('topic')); }
  if (p.get('story')) { where.push('ai_story = ?'); args.push(p.get('story')); }
  if (p.get('saved') === '1') where.push('saved = 1');
  if (p.get('ads') !== '1') where.push("coalesce(json_extract(flags, '$.ad'), 0) = 0");
  if (p.get('q')) { where.push('rowid in (select rowid from items_fts where items_fts match ?)'); args.push(ftsQuery(p.get('q'))); }
  if (p.get('since')) { where.push('first_seen > ?'); args.push(Number(p.get('since'))); }
  const order = p.get('sort') === 'published' ? 'coalesce(published_at, first_seen) desc, rowid' : p.get('sort') === 'repeated' ? 'seen_count desc, first_seen desc' : 'first_seen desc, rowid';
  const limit = Math.min(200, Number(p.get('limit')) || 50);
  const offset = Math.max(0, Number(p.get('offset')) || 0);
  const sql = `select * from items ${where.length ? 'where ' + where.join(' and ') : ''} order by ${order} limit ${limit} offset ${offset}`;
  return db.prepare(sql).all(...args).map(rowOut);
}

function facets() {
  const since = Date.now() - 4 * 864e5;
  const cfg = readConfig().ai || {};
  return {
    platforms: db.prepare('select platform, count(*) n, max(first_seen) last from items group by platform order by n desc').all(),
    contexts: db.prepare('select platform, context, count(*) n from items group by platform, context order by n desc').all(),
    topics: db.prepare('select value topic, count(*) n from items, json_each(items.ai_topics) group by value order by n desc limit 60').all(),
    stories: db.prepare(`select ai_story story, count(*) n, count(distinct platform) platforms, group_concat(distinct platform) list, max(first_seen) last
                         from items where ai_story is not null and first_seen > ? group by ai_story having n > 1 order by platforms desc, n desc limit 40`).all(since),
    ai: { enabled: !!(cfg.enabled && (cfg.apiKey || process.env.FEEDMERGE_AI_KEY)), pending: db.prepare('select count(*) n from items where ai_done = 0').get().n },
    total: db.prepare('select count(*) n, max(first_seen) last from items').get(),
    captures: db.prepare('select count(*) n from raw').get().n,
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req, max = 30e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!HOSTS.has(req.headers.host)) return send(res, 403, { error: 'host' });
    const u = new URL(req.url, `http://${req.headers.host}`);
    const mutating = req.method !== 'GET';
    // Writes need a custom header: plain web pages can't add it to a cross-origin request without a preflight we never allow.
    if (mutating && req.headers['x-feedmerge'] !== '1') return send(res, 403, { error: 'header' });

    if (req.method === 'POST' && u.pathname === '/ingest') {
      const cap = JSON.parse(await readBody(req));
      const r = ingest(cap);
      if (r.added) log('ingest', cap.platform, `+${r.added}/${r.parsed}`, (cap.url || '').slice(0, 100));
      return send(res, 200, r);
    }
    if (req.method === 'GET' && u.pathname === '/api/items') return send(res, 200, listItems(u.searchParams));
    if (req.method === 'GET' && u.pathname === '/api/facets') return send(res, 200, facets());
    if (req.method === 'POST' && u.pathname === '/api/reparse') { const r = reparse(); log('reparse', JSON.stringify(r)); return send(res, 200, r); }
    if (req.method === 'GET' && u.pathname === '/api/sources') {
      return send(res, 200, db.prepare(`select s.*, (select count(*) from items where platform = 'web' and context = s.name) items from sources s order by s.created desc`).all());
    }
    if (req.method === 'POST' && u.pathname === '/api/sources') {
      const body = JSON.parse(await readBody(req, 1e5) || '{}');
      const cfg = readConfig();
      const r = await resolveSource(body.input, { locale: body.locale || cfg.news?.locale, rsshub: cfg.rsshub || 'http://127.0.0.1:1200' });
      const name = (body.name || r.name).slice(0, 120);
      const interval = Math.max(10, Number(body.interval) || (r.kind === 'page' ? 60 : 30));
      const ex = db.prepare('select id from sources where url = ?').get(r.url);
      if (ex) return send(res, 409, { error: 'Already added', id: ex.id });
      const id = db.prepare('insert into sources(kind, name, url, interval_min, created) values (?, ?, ?, ?, ?)').run(r.kind, name, r.url, interval, Date.now()).lastInsertRowid;
      await poller.pollNow(id);
      log('source added', r.kind, name, r.url);
      return send(res, 200, db.prepare('select * from sources where id = ?').get(id));
    }
    const srcAct = /^\/api\/sources\/(\d+)\/(delete|refresh|toggle)$/.exec(u.pathname);
    if (req.method === 'POST' && srcAct) {
      const id = Number(srcAct[1]);
      if (srcAct[2] === 'delete') db.prepare('delete from sources where id = ?').run(id);
      if (srcAct[2] === 'toggle') db.prepare('update sources set enabled = 1 - enabled where id = ?').run(id);
      if (srcAct[2] === 'refresh') { db.prepare('update sources set last_hash = null where id = ?').run(id); await poller.pollNow(id); }
      return send(res, 200, { ok: true });
    }
    const save = /^\/api\/items\/(.+)\/save$/.exec(u.pathname);
    if (req.method === 'POST' && save) {
      const { saved } = JSON.parse(await readBody(req, 1e4) || '{}');
      db.prepare('update items set saved = ? where id = ?').run(saved ? 1 : 0, decodeURIComponent(save[1]));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
      const file = path.join(DIR, 'viewer', path.normalize(rel));
      if (file.startsWith(path.join(DIR, 'viewer') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', req.method, req.url, e.message);
    send(res, 500, { error: e.message });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log(`port ${PORT} already in use; another FeedMerge is probably running`); process.exit(0); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  log(`FeedMerge on http://127.0.0.1:${PORT}`);
  startTagger(db, readConfig, log);
  poller = startPoller(db, ingest, log, readConfig);
});
