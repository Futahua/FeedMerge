// Article bodies for general web posts, so their cards can show the text itself.
// The page is fetched through the guarded source fetcher, Readability finds the main
// content, and it is reduced to plain blocks (headings, paragraphs, quotes, list items,
// images). The site's own HTML never reaches the viewer, so it cannot run anything there.
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { fetchSource } from './source-fetch.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const MAX_BLOCKS = 400;
const JUNK = ['nav', 'header', 'footer', 'aside', 'form', 'dialog', 'menu', 'iframe', 'noscript', '[hidden]', '[aria-hidden="true"]', '[role="dialog"]', '[role="navigation"]', '[role="menu"]',
  '[class*="modal" i]', '[class*="popup" i]', '[class*="survey" i]', '[class*="shortcut" i]', '[class*="breadcrumb" i]', '[class*="related" i]', '[class*="share" i]', '[class*="comment" i]', '[id*="modal" i]', '[id*="popup" i]'].join(',');

export function initArticles(db) {
  db.exec(`create table if not exists articles (item_id text primary key, fetched_at integer, ok integer, blocks text, error text)`);
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const absolute = (u, base) => { try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };

export function articleBlocks(html, url) {
  const { document } = parseHTML(html);
  // Page furniture Readability sometimes mistakes for content: menus, pop-ups, surveys,
  // player help panels and anything the page itself keeps hidden.
  for (const el of document.querySelectorAll(JUNK)) el.remove();
  const pageTitle = clean(document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.querySelector('h1')?.textContent);
  const parsed = new Readability(document, { charThreshold: 300 }).parse();
  if (!parsed?.content) return null;
  const { document: doc } = parseHTML(`<!doctype html><html><body>${parsed.content}</body></html>`);
  const blocks = [];
  const seenImg = new Set();
  const visit = el => {
    if (blocks.length >= MAX_BLOCKS) return;
    const tag = el.tagName?.toLowerCase();
    if (!tag) return;
    if (tag === 'img' || tag === 'picture') {
      const im = tag === 'img' ? el : el.querySelector('img');
      const src = absolute(im?.getAttribute('data-src') || im?.getAttribute('src'), url);
      // Icons, logos and badges (an author silhouette, an "Ask AI" badge) are not article pictures: SVGs, and
      // anything the page itself sizes under 100 px, would otherwise be drawn as a full-width image.
      const w = Number(im?.getAttribute('width')) || 0, h = Number(im?.getAttribute('height')) || 0;
      const icon = /.svg(?:[?#]|$)/i.test(src || '') || (w && w < 100) || (h && h < 100);
      if (src && !icon && !seenImg.has(src) && !/^data:/.test(src)) {
        seenImg.add(src);
        blocks.push({ t: 'img', src, w: Number(im.getAttribute('width')) || undefined, h: Number(im.getAttribute('height')) || undefined, alt: clean(im.getAttribute('alt')) || undefined });
      }
      return;
    }
    if (tag === 'figcaption') { const text = clean(el.textContent); if (text) blocks.push({ t: 'cap', text }); return; }
    if (/^h[1-6]$/.test(tag)) { const text = clean(el.textContent); if (text) blocks.push({ t: 'h', text }); return; }
    if (tag === 'li') { const text = clean(el.textContent); if (text) blocks.push({ t: 'li', text }); return; }
    if (tag === 'blockquote') { const text = clean(el.textContent); if (text) blocks.push({ t: 'q', text }); return; }
    if (tag === 'p' || tag === 'pre') {
      for (const im of el.querySelectorAll('img')) visit(im);
      const text = clean(el.textContent);
      if (text) blocks.push({ t: 'p', text });
      return;
    }
    for (const c of el.children) visit(c);
  };
  for (const c of doc.body.children) visit(c);
  // A lone container of text with no paragraph tags: fall back to its plain text.
  if (!blocks.some(b => b.t === 'p') && clean(parsed.textContent)) blocks.push({ t: 'p', text: clean(parsed.textContent).slice(0, 20000) });
  // Everything up to the headline is page furniture (menus, dates); the headline itself is
  // already on the card.
  const norm = t => clean(t).toLowerCase();
  const head = blocks.findIndex(b => b.t === 'h' && pageTitle && (norm(b.text) === norm(pageTitle) || norm(pageTitle).startsWith(norm(b.text))));
  if (head >= 0 && head < 40) blocks.splice(0, head + 1);
  // Runs of short list items are menus or link lists, not writing.
  for (let i = 0; i < blocks.length; i++) {
    let j = i;
    while (j < blocks.length && blocks[j].t === 'li' && blocks[j].text.length < 30) j++;
    if (j - i >= 4) { blocks.splice(i, j - i); i--; }
  }
  // "Log in / sign up to read" notices are the site's, not the article's.
  const gate = /đăng nhập|đăng ký|log ?in|sign (?:in|up)|subscribe/i;
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].text && blocks[i].text.length < 300 && gate.test(blocks[i].text)) blocks.splice(i, 1);
  // Before the first real paragraph, short lines are page furniture: buttons ("Save", "Print"), font-size
  // controls, dates, bylines, field labels. Pictures there (the lead photo) stay.
  const first = blocks.findIndex(b => b.t === 'p' && b.text.length >= 80);
  if (first > 0) for (let i = first - 1; i >= 0; i--) if (blocks[i].t !== 'img') blocks.splice(i, 1);
  // Too little real writing to be an article (a menu, a cookie notice, a login-gated document page): nothing to show.
  if (blocks.reduce((n, b) => n + (b.text?.length || 0), 0) < 200) return null;
  // A paragraph opening with the headline's first words repeats the title (document portals print it several times).
  const lead = norm(pageTitle).split(' ').slice(0, 3).join(' ');
  const titled = t => lead.length >= 8 && norm(t).startsWith(lead);
  if (blocks.filter(b => b.t === 'p' && b.text.length >= 120 && !titled(b.text)).reduce((n, b) => n + b.text.length, 0) < 400) return null;
  return { title: clean(parsed.title), byline: clean(parsed.byline) || undefined, site: clean(parsed.siteName) || undefined, blocks };
}

const inflight = new Map();

// Cached; a failed fetch is retried after a day.
export async function getArticle(db, item) {
  const row = db.prepare('select * from articles where item_id = ?').get(item.id);
  if (row && (row.ok || Date.now() - row.fetched_at < 86400e3)) return row.ok ? JSON.parse(row.blocks) : { error: row.error };
  if (inflight.has(item.id)) return inflight.get(item.id);
  const job = (async () => {
    let result, error;
    try {
      const { res, text, type } = await fetchSource(item.url, { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' }, { timeout: 20000, maxBytes: 5 * 1024 * 1024 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!/html/i.test(type)) throw new Error('Not a web page');
      result = articleBlocks(text, res.url);
      if (!result?.blocks.length) throw new Error('No article text found');
    } catch (e) { error = e.message || String(e); }
    db.prepare(`insert into articles(item_id, fetched_at, ok, blocks, error) values (?, ?, ?, ?, ?)
      on conflict(item_id) do update set fetched_at = excluded.fetched_at, ok = excluded.ok, blocks = excluded.blocks, error = excluded.error`)
      .run(item.id, Date.now(), result ? 1 : 0, result ? JSON.stringify(result) : null, error || null);
    return result || { error };
  })().finally(() => inflight.delete(item.id));
  inflight.set(item.id, job);
  return job;
}
