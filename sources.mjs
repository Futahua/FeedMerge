// Web sources (news sites, blogs, topic searches, RSSHub routes, plain pages) polled by the
// server itself, so they stay fresh without any browser open.
import { createHash } from 'node:crypto';
import { normalizeRules, filterSourceLinks } from './source-rules.mjs';
import { fetchSource } from './source-fetch.mjs';

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
  for (const column of ['extraction_rules text', 'browser_report text']) {
    try { db.exec('alter table sources add column ' + column); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
  }
}

async function get(url, extraHeaders = {}, options = {}) {
  return fetchSource(url, { 'user-agent': new URL(url).hostname==='news.ycombinator.com'?'FeedMerge/0.3 (personal feed reader)':UA, accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5', ...extraHeaders }, options);
}

const looksLikeFeed = (text, type) => /(rss|atom|feed\+json|xml)/i.test(type) && /<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 3000))
  || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 3000))
  || (/json/i.test(type) && /"version"\s*:\s*"https:\/\/jsonfeed\.org/.test(text.slice(0, 500)));

function feedTitle(text) {
  const m = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(text);
  return m ? m[1].trim().replace(/\s+/g, ' ').slice(0, 120) : null;
}

export function discoverFeeds(html, base) {
  html = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?alternate/i.test(tag) || !/type=["']?application\/(rss\+xml|atom\+xml|feed\+json|json)/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) try { out.push(new URL(href.replace(/&amp;/g, '&'), base).href); } catch {}
  }
  // Publishers often expose their feeds on an RSS directory rather than in <link> tags.
  for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const href=m[1].replace(/&amp;/g,'&');
    if(!/(?:\.(?:rss|xml|atom)(?:[?#]|$)|\/(?:feed|rss)(?:[/?#]|$))/i.test(href))continue;
    try{out.push(new URL(href,base).href);}catch{}
  }
  return out.filter(u => !/comments\/feed|\/comments\b/i.test(u));
}

export function googleNewsUrl(query, locale = 'en-US') {
  const l = LOCALES[locale] || LOCALES['en-US'];
  const q = /\bwhen:\d+[hdy]\b/.test(query) ? query : `${query} when:7d`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${l.hl}&gl=${l.gl}&ceid=${l.ceid}`;
}

// Works out what a pasted input is: a topic, an RSSHub route, a feed, or a page with/without a feed.
export async function resolveSource(input, { locale, rsshub = 'http://127.0.0.1:1200', browserFallback = false } = {}) {
  const deadline=Date.now()+20000;
  const read=(url,options={})=>{const remaining=deadline-Date.now();if(remaining<=0)throw Error('Source discovery exceeded 20 seconds.');return get(url,{}, {...options,timeout:Math.min(10000,remaining)});};
  const s = String(input || '').trim();
  if (!s) throw new Error('Empty input');
  if (s.startsWith('/') || /^rsshub:/i.test(s)) {
    const route = s.replace(/^rsshub:/i, '').replace(/^\/?/, '/');
    const url = rsshub.replace(/\/+$/, '') + route;
    const { res, text } = await read(url, { trustedOrigin: rsshub });
    if (!res.ok || !looksLikeFeed(text, 'xml')) throw new Error(`RSSHub route failed (HTTP ${res.status}). Is RSSHub running, and is the route right?`);
    return { kind: 'feed', url, name: feedTitle(text) || route };
  }
  if (!/^https?:\/\//i.test(s) && (/\s/.test(s) || !/\.[a-z]{2,}(\/|$)/i.test(s))) {
    return { kind: 'feed', url: googleNewsUrl(s, locale), name: `News: ${s}` };
  }
  const url = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  const { res, text, type } = await read(url);
  if (!res.ok) {
    if(browserFallback && [401,403,405,406,419,429,503].includes(res.status))return {kind:'rendered',url:res.url||url,name:new URL(url).host+' (browser)',reason:`HTTP ${res.status}; requires a permitted browser; no capture verified.`};
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  }
  if (looksLikeFeed(text, type)) return { kind: 'feed', url: res.url || url, name: feedTitle(text) || new URL(url).host };
  const found = discoverFeeds(text, res.url || url);
  const base = new URL(res.url || url);
  const candidates = [...found, ...COMMON_PATHS.map(p => new URL(p, base.origin).href)];
  for (const c of [...new Set(candidates)].slice(0, 10)) {
    try {
      const f = await read(c);
      if (f.res.ok && looksLikeFeed(f.text, f.type)) return { kind: 'feed', url: f.res.url || c, name: feedTitle(f.text) || base.host };
    } catch {}
  }
  const links = extractLinks(text, res.url || url);
  // A JavaScript app sends an empty shell that only a browser fills in: the extension reads
  // it in the background refresh window instead (see extension/background.js).
  if (links.length < 3 && appShell(text)) return { kind: 'rendered', url: res.url || url, name: ((feedTitle(text) || '').split(/ [-|–] /)[0].trim() || base.host) + ' (browser)' };
  if(links.length<3 && browserFallback)return {kind:'rendered',url:res.url||url,name:feedTitle(text)||base.host,reason:'No usable server-rendered headlines; awaiting a permitted browser, not verified.'};
  if (links.length < 3) throw new Error('No feed found and too few article links on that page to watch it');
  return { kind: 'page', url: res.url || url, name: (feedTitle(text) || base.host) + ' (page)' };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);

// Almost no visible text, an app mount point and scripts: rendered by JavaScript.
export function appShell(html) {
  const body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] || '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return body.length < 400 && /<script\b/i.test(html) && /id=["'](__nuxt|__next|root|app|svelte)["']|<app-root|data-reactroot|ng-version|document\.cookie|location\.reload|checking your browser|captcha/i.test(html);
}

// Headline-like links on a page with no feed: long anchor text, same site, deeper than the home page.
export function extractLinks(html, base, rules = {}) {
  const r = normalizeRules(rules);
  if (r.linkSelector !== 'a[href]') throw Error('Custom CSS selectors require browser mode.');
  const candidates = [];
  // Navigation inside scripts/styles is not visible content.
  html = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    candidates.push({url:decode(m[1]), title:decode(m[2].replace(/<[^>]+>/g, ' '))});
  }
  return filterSourceLinks(candidates, base, r);
}

// Uses the same checked fetch and extractor as polling, never an agent-owned fetcher.
export async function inspectSource(src, rules = {}, suppliedHtml) {
  const r = normalizeRules(rules);
  const fetched = suppliedHtml === undefined ? await get(src.url) : null;
  const html = suppliedHtml ?? fetched.text;
  const finalUrl = fetched?.res.url || src.url;
  const requiresBrowser = r.linkSelector !== 'a[href]';
  const links = requiresBrowser ? [] : extractLinks(html, finalUrl, r);
  const visible = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  return {input:suppliedHtml === undefined?'checked_fetch':'supplied_html',status:fetched?.res.status ?? null,final_url:finalUrl,title:feedTitle(html),app_shell:appShell(html),visible_characters:visible.length,script_count:(html.match(/<script\b/gi)||[]).length,rules:r,extracted_count:links.length,links,
    warning:requiresBrowser?'CSS selection must be tested by a browser capture; these links were not evaluated.':fetched&&!fetched.res.ok?'HTTP error; no source changes were made.':!links.length?'No matching headlines. May require browser permission/login or different extraction rules.':null};
}

// Poll due sources; store a raw capture only when the content changed.
export function startPoller(db, ingest, log, readConfig, {schedule=true} = {}) {
  initSources(db);
  let running = false;
  const due = db.prepare("select * from sources where enabled = 1 and kind != 'rendered' and (last_fetch is null or last_fetch + interval_min * 60000 <= ?) order by last_fetch limit 8");
  const mark = db.prepare('update sources set last_fetch = ?, last_ok = coalesce(?, last_ok), last_error = ?, etag = coalesce(?, etag), last_modified = coalesce(?, last_modified), last_hash = coalesce(?, last_hash), last_count = coalesce(?, last_count) where id = ?');

  async function pollOne(src) {
    const now = Date.now();
    try {
      const headers = src.kind === 'feed' ? { ...(src.etag ? { 'if-none-match': src.etag } : {}), ...(src.last_modified ? { 'if-modified-since': src.last_modified } : {}) } : {};
      const rsshub = new URL(readConfig().rsshub || 'http://127.0.0.1:1200').origin;
      const { res, text } = await get(src.url, headers, { trustedOrigin: rsshub });
      if (res.status === 304) return mark.run(now, now, null, null, null, null, null, src.id);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = src.kind === 'page' ? JSON.stringify(extractLinks(text, res.url || src.url, JSON.parse(src.extraction_rules || '{}'))) : text;
      const hash = sha(payload);
      let added = null;
      if (hash !== src.last_hash) {
        const r = await ingest({ platform: 'web', kind: src.kind === 'page' ? 'links' : 'feed', url: src.url, pageUrl: `source:${src.name}`, capturedAt: now, payload });
        added = r.parsed;
        if (r.added) log('source', src.name, `+${r.added}/${r.parsed}`);
      }
      mark.run(now, now, null, res.headers.get('etag'), res.headers.get('last-modified'), hash, added, src.id);
    } catch (e) {
      mark.run(now, null, String(e.message || e).slice(0, 200), null, null, null, null, src.id);
    }
  }

  async function tick() {
    if (running || readConfig().sources?.pollingEnabled === false) return;
    running = true;
    try {
      const list = due.all(Date.now());
      for (let i = 0; i < list.length; i += 4) await Promise.all(list.slice(i, i + 4).map(pollOne));
    } finally { running = false; }
  }
  if(schedule){setInterval(tick, 60_000).unref?.();setTimeout(tick, 3_000).unref?.();}
  return { pollNow: async id => { const s = db.prepare('select * from sources where id = ?').get(id); if (s && s.kind !== 'rendered') await pollOne(s); } };
}
