// FeedMerge local store: receives captures from the browser extension, keeps every raw
// capture, rebuilds normalized items from them, and serves the merged-feed viewer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseCapture } from './parsers.mjs';
import { startTagger } from './ai.mjs';
import { initSources, resolveSource, startPoller } from './sources.mjs';
import { initCategories, startCategorizer } from './categorize.mjs';
import { initCloudflare, startCloudflare, embeddingStories, cloudflareConfig } from './cloudflare.mjs';
import { transaction } from './sqlite-transaction.mjs';
import { reparseCaptures } from './reparse.mjs';
import { expire, retentionSettings, NAVIGATION } from './retention.mjs';
import { createManagement } from './management.mjs';
import { initArticles, getArticle } from './article.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.FEEDMERGE_DATA_DIR || path.join(DIR, 'data');
const CONFIG = process.env.FEEDMERGE_CONFIG || path.join(DIR, 'config.json');
fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(CONFIG)) fs.copyFileSync(path.join(DIR, 'config.example.json'), CONFIG);

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}
const PORT = Number(process.env.FEEDMERGE_PORT || readConfig().port || 4747);
// Only these Host headers are served (blocks DNS-rebinding pages). config.json "hosts" adds
// names that reach FeedMerge through a private proxy, e.g. its Tailscale address.
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...(readConfig().hosts || [])]);

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
-- Several accounts per site, one per Chrome profile, merged into this one feed. A post is
-- stored once; item_accounts records which profiles were shown it, profile_accounts which
-- account each profile is signed into per site (where the site exposes it).
create table if not exists item_accounts (item_id text, profile text, first_seen integer, last_seen integer, seen integer default 1, primary key (item_id, profile));
create table if not exists profile_accounts (profile text, platform text, account text, last_seen integer, primary key (profile, platform));
`);
try { db.exec('alter table raw add column profile text'); } catch {}

initSources(db);
initArticles(db);
initCategories(db);
initCloudflare(db);
const management = createManagement(db);
let poller = null;
let categorizer = null;
let cf = null;

const q = {
  rawIns: db.prepare('insert into raw(platform, kind, url, page_url, captured_at, body, profile) values (?, ?, ?, ?, ?, ?, ?)'),
  acct: db.prepare(`insert into profile_accounts(profile, platform, account, last_seen) values (?, ?, ?, ?)
                    on conflict(profile, platform) do update set account = excluded.account, last_seen = excluded.last_seen`),
  sighting: db.prepare(`insert into item_accounts(item_id, profile, first_seen, last_seen, seen) values (?, ?, ?, ?, 1)
                        on conflict(item_id, profile) do update set first_seen = min(first_seen, excluded.first_seen), last_seen = max(last_seen, excluded.last_seen), seen = seen + ?`),
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

function ingest(cap, keepRaw = true, strict = false) {
  const t = Number(cap.capturedAt) || Date.now();
  const text = typeof cap.payload === 'string' ? cap.payload : JSON.stringify(cap.payload ?? null);
  const profile = /^[a-f0-9]{8,32}$/.test(cap.profile || '') ? cap.profile : null;
  if (keepRaw) q.rawIns.run(s(cap.platform), s(cap.kind), s(cap.url) || '', s(cap.pageUrl) || '', t, gzipSync(text), profile);
  if (profile && keepRaw && /^\d{1,40}$/.test(cap.account || '')) q.acct.run(profile, s(cap.platform), cap.account, t);
  let items = [];
  try { items = parseCapture({ platform: cap.platform, kind: cap.kind, url: cap.url, pageUrl: cap.pageUrl, capturedAt: t, text }); }
  catch (e) { log('parse error', cap.platform, cap.url, e.message); if (strict) throw e; }
  const seen = new Set();
  let added = 0;
  transaction(db, () => {
    for (const it of items) {
      // Pages you navigate to (a thread's replies, a profile, a search) are not what your
      // feeds pushed to you: they are not stored, and seeing a post there doesn't refresh it.
      if (NAVIGATION.has(it.context)) continue;
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
      // A rebuild replays captures, so it fixes dates without counting the sighting again.
      if (profile) q.sighting.run(it.id, profile, t, t, keepRaw ? 1 : 0);
    }
  });
  return { parsed: seen.size, added };
}

// Rebuild every item from stored raw captures, keeping AI labels and saves.
function reparse() {
  return reparseCaptures(db, ingest);
}

function rowOut(r) {
  const p = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return {
    id: r.id, platform: r.platform, nativeId: r.native_id, context: r.context, author: r.author, authorName: r.author_name, title: r.title, text: r.text,
    url: r.url, media: p(r.media) || [], publishedAt: r.published_at, firstSeen: r.first_seen, lastSeen: r.last_seen,
    seenCount: r.seen_count, metrics: p(r.metrics) || {}, flags: p(r.flags) || {}, labels: [], saved: !!r.saved,
  };
}

function attachLabels(items) {
  if (!items.length) return items;
  const rows = db.prepare(`select il.item_id, l.id, l.layer, l.name, il.prob, il.source, il.decided from item_labels il join labels l on l.id = il.label_id
    where il.decided >= 0 and il.item_id in (${items.map(() => '?').join(',')}) order by il.decided desc, il.prob desc`).all(...items.map(i => i.id));
  const by = new Map(items.map(i => [i.id, i]));
  for (const r of rows) by.get(r.item_id)?.labels.push({ id: r.id, layer: r.layer, name: r.name, prob: r.prob, source: r.source, decided: r.decided });
  return items;
}

function categories() {
  const since = Date.now() - 4 * 864e5;
  const labels = db.prepare(`select l.id, l.layer, l.name, l.description, l.keywords, l.source,
      (select count(*) from item_labels il where il.label_id = l.id and il.decided >= 0) n,
      (select count(distinct i.platform) from item_labels il join items i on i.id = il.item_id where il.label_id = l.id and il.decided >= 0) platforms
    from labels l where l.id not in (select from_id from story_aliases) order by l.layer, n desc, l.name`).all();
  const storyRecent = new Set(db.prepare(`select distinct il.label_id id from item_labels il join items i on i.id = il.item_id join labels l on l.id = il.label_id
    where l.layer = 'story' and i.first_seen > ?`).all(since).map(r => r.id));
  const layers = db.prepare('select id, name from layers order by sort').all().map(l => ({
    ...l,
    labels: labels.filter(x => x.layer === l.id && (l.id !== 'story' || storyRecent.has(x.id)))
      .map(x => ({ id: x.id, name: x.name, description: x.description, keywords: x.keywords ? JSON.parse(x.keywords) : null, source: x.source, n: x.n, platforms: x.platforms })),
  }));
  const review = db.prepare(`select count(distinct item_id) n from item_labels where decided = 0 and source not in ('rule') and prob < 0.7 and not exists (select 1 from post_reviews r where r.item_id=item_labels.item_id and r.reviewed_at>=item_labels.updated)`).get().n;
  return { layers, review };
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
  for (const id of (p.get('label') || '').split(',').filter(Boolean)) {
    where.push('exists (select 1 from item_labels il where il.item_id = items.id and il.label_id = ? and il.decided >= 0)');
    args.push(Number(id));
  }
  if (p.get('review') === '1') where.push(`exists (select 1 from item_labels il where il.item_id = items.id and il.decided = 0 and il.source != 'rule' and il.prob < 0.7 and not exists (select 1 from post_reviews r where r.item_id=items.id and r.reviewed_at>=il.updated))`);
  if (p.get('saved') === '1') where.push('saved = 1');
  if (p.get('ads') !== '1') where.push("coalesce(json_extract(flags, '$.ad'), 0) = 0");
  if (p.get('q')) { where.push('rowid in (select rowid from items_fts where items_fts match ?)'); args.push(ftsQuery(p.get('q'))); }
  if (p.get('since')) { where.push('first_seen > ?'); args.push(Number(p.get('since'))); }
  const seed = Math.max(1, Math.min(1000000000, Math.floor(Number(p.get('seed'))) || 1));
  const order = p.get('sort') === 'shuffle' ? `((rowid * ${seed} % 2147483647) * 48271 % 2147483647), rowid` : p.get('sort') === 'published' ? 'coalesce(published_at, first_seen) desc, rowid' : p.get('sort') === 'repeated' ? 'seen_count desc, first_seen desc' : 'first_seen desc, rowid';
  const limit = Math.min(200, Number(p.get('limit')) || 50);
  const offset = Math.max(0, Number(p.get('offset')) || 0);
  const sql = `select * from items ${where.length ? 'where ' + where.join(' and ') : ''} order by ${order} limit ${limit} offset ${offset}`;
  return attachLabels(db.prepare(sql).all(...args).map(rowOut));
}

function facets() {
  const since = Date.now() - 4 * 864e5;
  const cfg = readConfig().ai || {};
  return {
    platforms: db.prepare('select platform, count(*) n, max(first_seen) last from items group by platform order by n desc').all(),
    contexts: db.prepare('select platform, context, count(*) n from items group by platform, context order by n desc').all(),
    accounts: db.prepare(`select platform, count(distinct account) n, max(last_seen) last from profile_accounts group by platform order by platform`).all(),
    profiles: db.prepare('select count(distinct profile) n from raw where profile is not null').get().n,
    ai: {
      enabled: !!(cfg.enabled && (cfg.apiKey || process.env.FEEDMERGE_AI_KEY)) || !!cf?.active(),
      provider: cf?.active() ? 'cloudflare' : cfg.enabled ? 'chat' : 'mock',
      usage: cf?.active() ? cf.usage() : null,
      pending: db.prepare("select count(*) n from items where cf_done = 0 and last_seen > ? and coalesce(json_extract(flags, '$.ad'), 0) = 0").get(Date.now() - 2 * 864e5).n,
      embedded: db.prepare('select count(*) n from embeddings').get().n,
    },
    total: db.prepare('select count(*) n, max(first_seen) last from items').get(),
    captures: db.prepare('select count(*) n from raw').get().n,
  };
}

// ---------- Media proxy + cache ----------
// Instagram/TikTok media links expire after days, and some (Instagram avatars) refuse to
// display on other sites. Images you actually look at are fetched once and kept on disk.
const MEDIA_DIR = path.join(DATA, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const MEDIA_HOSTS = /(^|\.)(fbcdn\.net|cdninstagram\.com|pinimg\.com|tiktokcdn\.com|tiktokcdn-us\.com|twimg\.com|ytimg\.com|ggpht\.com|redd\.it|redditmedia\.com|redditstatic\.com|bsky\.app|bsky\.social)$/;
const MEDIA_CAP = 3e9;
const inflight = new Map();

async function mediaProxy(res, raw) {
  let u;
  try { u = new URL(raw); } catch { return send(res, 400, { error: 'bad url' }); }
  if (u.protocol !== 'https:' || !MEDIA_HOSTS.test(u.hostname)) return send(res, 403, { error: 'host not allowed' });
  const key = createHash('sha1').update(u.href).digest('hex');
  const file = path.join(MEDIA_DIR, key);
  if (!fs.existsSync(file)) {
    if (!inflight.has(key)) inflight.set(key, (async () => {
      const r = await fetch(u.href, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' }, signal: AbortSignal.timeout(20_000) });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !type.startsWith('image/')) throw new Error(`upstream ${r.status} ${type}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 8e6) throw new Error('too large');
      fs.writeFileSync(file + '.tmp', buf);
      fs.writeFileSync(file + '.type', type);
      fs.renameSync(file + '.tmp', file);
    })().finally(() => inflight.delete(key)));
    try { await inflight.get(key); } catch (e) { return send(res, 502, { error: e.message }); }
  }
  res.writeHead(200, { 'content-type': fs.readFileSync(file + '.type', 'utf8'), 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

function pruneMedia() {
  try {
    const files = fs.readdirSync(MEDIA_DIR).filter(f => !f.includes('.')).map(f => { const s = fs.statSync(path.join(MEDIA_DIR, f)); return { f, size: s.size, t: s.atimeMs }; });
    let total = files.reduce((a, b) => a + b.size, 0);
    for (const x of files.sort((a, b) => a.t - b.t)) {
      if (total <= MEDIA_CAP) break;
      for (const ext of ['', '.type']) fs.rmSync(path.join(MEDIA_DIR, x.f + ext), { force: true });
      total -= x.size;
    }
  } catch (e) { log('media prune', e.message); }
}
setInterval(pruneMedia, 3600e3).unref();

// Retention: the feed stays current; see retention.mjs.
function runRetention() {
  try { const r = expire(db); if (r.posts || r.raw) log('retention', JSON.stringify(r)); } catch (e) { log('retention failed', e.message); }
}
setTimeout(runRetention, 30e3).unref();
setInterval(runRetention, 3600e3).unref();

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
    if(mutating&&req.headers['x-feedmerge-agent']==='1'&&readConfig().agent?.writes===false)return send(res,403,{error:'Agent writes are disabled by the local owner.'});

    if (req.method === 'POST' && u.pathname === '/ingest') {
      const cap = JSON.parse(await readBody(req));
      const r = ingest(cap);
      if (r.added) log('ingest', cap.platform, `+${r.added}/${r.parsed}`, (cap.url || '').slice(0, 100));
      return send(res, 200, r);
    }
    if (req.method === 'GET' && u.pathname === '/api/items') return send(res, 200, listItems(u.searchParams));
    if (req.method === 'GET' && u.pathname === '/api/article') {
      const item = db.prepare("select id, url from items where id = ? and platform = 'web'").get(u.searchParams.get('id') || '');
      if (!item?.url) return send(res, 404, { error: 'not a web post' });
      return send(res, 200, await getArticle(db, item));
    }
    const fullPost = /^\/api\/items\/(.+)$/.exec(u.pathname);
    if (req.method === 'GET' && fullPost) {
      const id = decodeURIComponent(fullPost[1]), item = db.prepare('select * from items where id=?').get(id);
      if (!item) return send(res, 404, { error: 'Post not found' });
      const similar = db.prepare('select a,b,sim from story_edges where a=? or b=? order by sim desc limit 50').all(id,id);
      return send(res, 200, { ...attachLabels([rowOut(item)])[0], review: db.prepare('select * from post_reviews where item_id=?').get(id) || null, similar });
    }
    if (req.method === 'GET' && u.pathname === '/api/ingestion-status') return send(res, 200, {
      observed_at: new Date().toISOString(), facets: facets(), jobs: management.jobs(cloudflareConfig(readConfig)?'cloudflare':readConfig().ai?.enabled?'chat':'rules'),
      sources: db.prepare('select id,kind,name,enabled,last_fetch,last_ok,last_error,last_count from sources order by id').all(),
      captures: db.prepare('select platform,count(*) captures,max(captured_at) last_capture from raw group by platform').all(),
    });
    if (req.method === 'GET' && u.pathname === '/api/agent/history') return send(res, 200, management.history());
    if (req.method === 'GET' && u.pathname === '/api/collections') return send(res, 200, management.collections());
    const agentAction = /^\/api\/agent\/(preview|apply|undo)$/.exec(u.pathname);
    if (req.method === 'POST' && agentAction) {
      if (readConfig().agent?.writes === false) return send(res, 403, { error: 'Agent writes are disabled by the local owner.' });
      const body = JSON.parse(await readBody(req, 100000) || '{}');
      if(agentAction[1]==='preview'&&body.operation==='source_control'&&body.input?.action==='add'){
        const cfg=readConfig();body.input.resolved=await resolveSource(body.input.input,{locale:body.input.locale||cfg.news?.locale,rsshub:cfg.rsshub||'http://127.0.0.1:1200'});
      }
      const result = agentAction[1] === 'preview' ? management.preview(body.operation, body.input || {})
        : agentAction[1] === 'apply' ? management.apply(body.preview_id,body.operation) : management.undo(body.receipt_id, body.apply === true);
      return send(res, 200, result);
    }
    if (req.method === 'GET' && u.pathname === '/media') return mediaProxy(res, u.searchParams.get('u'));
    if (req.method === 'GET' && u.pathname === '/api/facets') return send(res, 200, facets());
    if (req.method === 'GET' && u.pathname === '/api/retention') {
      let last = null; try { last = JSON.parse(db.prepare("select v from meta where k = 'retention_last'").get()?.v || 'null'); } catch {}
      return send(res, 200, { ...retentionSettings(db), last });
    }
    if (req.method === 'POST' && u.pathname === '/api/retention') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      for (const [k, key] of [['days', 'retention_days'], ['rawDays', 'retention_raw_days'], ['adDays', 'retention_ad_days']]) {
        if (b[k] === undefined) continue;
        const v = Number(b[k]); if (!Number.isFinite(v) || v <= 0 || v > 3650) return send(res, 400, { error: `${k} must be 1-3650 days` });
        db.prepare('insert into meta(k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(key, String(v));
      }
      return send(res, 200, retentionSettings(db));
    }
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
    if (req.method === 'GET' && u.pathname === '/api/categories') return send(res, 200, categories());
    // Confirm (1), reject (-1) or clear (0) a label on one post; or add a new label by name.
    const lab = /^\/api\/items\/(.+)\/label$/.exec(u.pathname);
    if (req.method === 'POST' && lab) {
      const itemId = decodeURIComponent(lab[1]);
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      if (!db.prepare('select id from items where id = ?').get(itemId)) return send(res, 404, { error: 'Post not found' });
      let labelId = Number(b.labelId);
      if (!labelId && b.layer && b.name) {
        const name = String(b.name).trim().slice(0, 80);
        labelId = db.prepare('select id from labels where layer = ? and name = ?').get(b.layer, name)?.id
          ?? db.prepare('insert into labels(layer, name, source, created) values (?, ?, ?, ?)').run(b.layer, name, b.source === 'agent' ? 'agent' : 'user', Date.now()).lastInsertRowid;
      }
      if (b.source === 'agent') {
        // An assistant's suggestion: never overrides your own decision on that label.
        const prob = Math.max(0, Math.min(1, Number(b.prob) || 0.7));
        db.prepare(`insert into item_labels(item_id, label_id, prob, source, decided, updated) values (?, ?, ?, 'agent', 0, ?)
          on conflict(item_id, label_id) do update set prob = excluded.prob, source = 'agent', updated = excluded.updated where item_labels.decided = 0`).run(itemId, labelId, prob, Date.now());
        return send(res, 200, { ok: true, labelId });
      }
      const decided = Math.max(-1, Math.min(1, Number(b.decided) || 0));
      db.prepare(`insert into item_labels(item_id, label_id, prob, source, decided, updated) values (?, ?, ?, 'user', ?, ?)
        on conflict(item_id, label_id) do update set decided = excluded.decided, updated = excluded.updated`).run(itemId, labelId, decided === 1 ? 1 : 0, decided, Date.now());
      return send(res, 200, { ok: true, labelId });
    }
    if (req.method === 'POST' && u.pathname === '/api/labels') {
      const b = JSON.parse(await readBody(req, 1e5) || '{}');
      const kw = Array.isArray(b.keywords) ? b.keywords.map(String).filter(Boolean).slice(0, 100) : null;
      const source = b.source === 'agent' ? 'agent' : 'user';
      if (b.id) {
        const existing = db.prepare('select name from labels where id = ?').get(Number(b.id));
        if (!existing) return send(res, 404, { error: 'Label not found' });
        if (b.expectedName !== undefined && existing.name !== b.expectedName) return send(res, 409, { error: 'Label changed since preview' });
        // A renamed label is pinned (source user/agent) so regrouping keeps its name.
        db.prepare(`update labels set name = coalesce(?, name), description = coalesce(?, description), keywords = case when ? then ? else keywords end,
          source = case when source in ('mock', 'ai') and ? is not null then ? else source end where id = ?`)
          .run(b.name || null, b.description ?? null, Array.isArray(b.keywords) ? 1 : 0, kw && kw.length ? JSON.stringify(kw) : null, b.name || null, source, Number(b.id));
      } else {
        db.prepare('insert into labels(layer, name, description, keywords, source, created) values (?, ?, ?, ?, ?, ?)').run(b.layer, String(b.name).trim().slice(0, 80), b.description || null, kw && kw.length ? JSON.stringify(kw) : null, source, Date.now());
      }
      categorizer.rulesChanged();
      cf?.labelsChanged();
      return send(res, 200, { ok: true });
    }
    const labDel = /^\/api\/labels\/(\d+)\/delete$/.exec(u.pathname);
    if (req.method === 'POST' && labDel) {
      db.prepare('delete from item_labels where label_id = ?').run(Number(labDel[1]));
      db.prepare('delete from labels where id = ?').run(Number(labDel[1]));
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
    send(res, e.status || 500, { error: e.message });
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
  categorizer = startCategorizer(db, log, {
    aiActive: () => !!cloudflareConfig(readConfig),
    aiStories: () => embeddingStories(db, log, Number(readConfig().cloudflare?.storyThreshold) || 0.8),
  });
  cf = startCloudflare(db, readConfig, log, { onEmbedded: () => categorizer.recluster() });
});
