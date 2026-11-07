// Web sources (news sites, blogs, topic searches, RSSHub routes, plain pages) polled by the
// server itself, so they stay fresh without any browser open.
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 FeedMerge/0.2';
const COMMON_PATHS = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/feeds/posts/default', '/?feed=rss2'];
const LOCALES = {
  'en-US': { hl: 'en-US', gl: 'US', ceid: 'US:en' },
  'en-GB': { hl: 'en-GB', gl: 'GB', ceid: 'GB:en' },
  'vi-VN': { hl: 'vi', gl: 'VN', ceid: 'VN:vi' },
};

const sha = s => createHash('sha1').update(s).digest('hex');

export function initSources(db) {
  db.exec(`create table if not exists sources (
    id integer primary key, kind text, name text, url text unique, interval_min integer default 30, enabled integer default 1,
    created integer, last_fetch integer, last_ok integer, last_error text, etag text, last_modified text, last_hash text, last_count integer)`);
}

async function get(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5', ...extraHeaders }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  const text = res.status === 304 ? '' : await res.text();
  return { res, text, type: res.headers.get('content-type') || '' };
}

const looksLikeFeed = (text, type) => /(rss|atom|feed\+json|xml)/i.test(type) && /<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 3000))
  || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 3000))
  || (/json/i.test(type) && /"version"\s*:\s*"https:\/\/jsonfeed\.org/.test(text.slice(0, 500)));

function feedTitle(text) {
  const m = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(text);
  return m ? m[1].trim().replace(/\s+/g, ' ').slice(0, 120) : null;
}

function discover(html, base) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?alternate/i.test(tag) || !/type=["']?application\/(rss\+xml|atom\+xml|feed\+json|json)/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) try { out.push(new URL(href.replace(/&amp;/g, '&'), base).href); } catch {}
  }
  return out.filter(u => !/comments\/feed|\/comments\b/i.test(u));
}

export function googleNewsUrl(query, locale = 'en-US') {
  const l = LOCALES[locale] || LOCALES['en-US'];
  const q = /\bwhen:\d+[hdy]\b/.test(query) ? query : `${query} when:7d`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${l.hl}&gl=${l.gl}&ceid=${l.ceid}`;
}

// Works out what a pasted input is: a topic, an RSSHub route, a feed, or a page with/without a feed.
export async function resolveSource(input, { locale, rsshub = 'http://127.0.0.1:1200' } = {}) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Empty input');
  if (s.startsWith('/') || /^rsshub:/i.test(s)) {
    const route = s.replace(/^rsshub:/i, '').replace(/^\/?/, '/');
    const url = rsshub.replace(/\/+$/, '') + route;
    const { res, text } = await get(url);
    if (!res.ok || !looksLikeFeed(text, 'xml')) throw new Error(`RSSHub route failed (HTTP ${res.status}). Is RSSHub running, and is the route right?`);
    return { kind: 'feed', url, name: feedTitle(text) || route };
  }
  if (!/^https?:\/\//i.test(s) && (/\s/.test(s) || !/\.[a-z]{2,}(\/|$)/i.test(s))) {
    return { kind: 'feed', url: googleNewsUrl(s, locale), name: `News: ${s}` };
  }
  const url = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  const { res, text, type } = await get(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  if (looksLikeFeed(text, type)) return { kind: 'feed', url: res.url || url, name: feedTitle(text) || new URL(url).host };
  const found = discover(text, res.url || url);
  const base = new URL(res.url || url);
  const candidates = [...found, ...COMMON_PATHS.map(p => new URL(p, base.origin).href)];
  for (const c of [...new Set(candidates)].slice(0, 10)) {
    try {
      const f = await get(c);
      if (f.res.ok && looksLikeFeed(f.text, f.type)) return { kind: 'feed', url: f.res.url || c, name: feedTitle(f.text) || base.host };
    } catch {}
  }
  const links = extractLinks(text, res.url || url);
  if (links.length < 3) throw new Error('No feed found and too few article links on that page to watch it');
  return { kind: 'page', url: res.url || url, name: (feedTitle(text) || base.host) + ' (page)' };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);

// Headline-like links on a page with no feed: long anchor text, same site, deeper than the home page.
export function extractLinks(html, base) {
  const origin = new URL(base);
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u;
    try { u = new URL(decode(m[1]), base); } catch { continue; }
    if (u.host.replace(/^www\./, '') !== origin.host.replace(/^www\./, '') || u.pathname.split('/').filter(Boolean).length < 1) continue;
    const title = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (title.length < 25 || title.length > 300) continue;
    u.hash = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ url: u.href, title });
    if (out.length >= 80) break;
  }
  return out;
}

// Poll due sources; store a raw capture only when the content changed.
export function startPoller(db, ingest, log, readConfig) {
  initSources(db);
  let running = false;
  const due = db.prepare('select * from sources where enabled = 1 and (last_fetch is null or last_fetch + interval_min * 60000 <= ?) order by last_fetch limit 8');
  const mark = db.prepare('update sources set last_fetch = ?, last_ok = coalesce(?, last_ok), last_error = ?, etag = coalesce(?, etag), last_modified = coalesce(?, last_modified), last_hash = coalesce(?, last_hash), last_count = coalesce(?, last_count) where id = ?');

  async function pollOne(src) {
    const now = Date.now();
    try {
      const headers = src.kind === 'feed' ? { ...(src.etag ? { 'if-none-match': src.etag } : {}), ...(src.last_modified ? { 'if-modified-since': src.last_modified } : {}) } : {};
      const { res, text } = await get(src.url, headers);
      if (res.status === 304) return mark.run(now, now, null, null, null, null, null, src.id);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = src.kind === 'page' ? JSON.stringify(extractLinks(text, res.url || src.url)) : text;
      const hash = sha(payload);
      let added = null;
      if (hash !== src.last_hash) {
        const r = ingest({ platform: 'web', kind: src.kind === 'page' ? 'links' : 'feed', url: src.url, pageUrl: `source:${src.name}`, capturedAt: now, payload });
        added = r.parsed;
        if (r.added) log('source', src.name, `+${r.added}/${r.parsed}`);
      }
      mark.run(now, now, null, res.headers.get('etag'), res.headers.get('last-modified'), hash, added, src.id);
    } catch (e) {
      mark.run(now, null, String(e.message || e).slice(0, 200), null, null, null, null, src.id);
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const list = due.all(Date.now());
      for (let i = 0; i < list.length; i += 4) await Promise.all(list.slice(i, i + 4).map(pollOne));
    } finally { running = false; }
  }
  setInterval(tick, 60_000).unref?.();
  setTimeout(tick, 3_000).unref?.();
  return { pollNow: async id => { const s = db.prepare('select * from sources where id = ?').get(id); if (s) await pollOne(s); } };
}
