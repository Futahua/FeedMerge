// Posts in languages other than English and Vietnamese are shown in English, with a note of
// the original language; the original stays stored (so re-captures and filters still work)
// but is not shown. Uses Google Translate's free web endpoint: hosted, no key, and it
// reports the source language. Vietnamese and obviously English posts never leave the
// machine. tr_done: 0 pending, 1 handled, -1 gave up on this post.
import { isVietnamese } from './retention.mjs';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t';
const CHUNK = 4500;
const names = new Intl.DisplayNames(['en'], { type: 'language' });
export const languageName = code => { try { return names.of(code) || code; } catch { return code; } };

export function initTranslations(db) {
  for (const c of ['tr_from text', 'tr_title text', 'tr_text text', 'tr_done integer default 0']) { try { db.exec(`alter table items add column ${c}`); } catch {} }
  db.exec('create index if not exists items_tr on items(tr_done)');
  db.exec('create table if not exists article_translations(item_id text primary key, article text)');
}

const COMMON = /\b(the|and|of|to|in|is|for|that|with|on|was|are|from|this|by|at|it|be|has|have|will|you)\b/gi;
export function looksEnglish(s) {
  const words = s.match(/\p{L}+/gu) || [];
  if (words.length < 6) return /^[\x00-\x7F]*$/.test(s) && words.length > 0 && (s.match(COMMON) || []).length > 0;
  return (s.match(COMMON) || []).length / words.length >= 0.12;
}

// Split on paragraph breaks (then lines, then hard cuts) into requests Google accepts.
function chunks(text) {
  const out = [];
  let cur = '';
  for (const piece of text.split(/(?<=\n\n)/)) {
    for (let p = piece; p; ) {
      const room = CHUNK - cur.length;
      if (p.length <= room) { cur += p; p = ''; }
      else if (cur) { out.push(cur); cur = ''; }
      else { out.push(p.slice(0, CHUNK)); p = p.slice(CHUNK); }
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Returns { lang, segments: [[translated, original], ...] } for the whole text.
export async function translateText(text, fetchImpl = fetch) {
  let lang = null;
  const segments = [];
  for (const part of chunks(text)) {
    const res = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams({ q: part }), signal: AbortSignal.timeout(20000) });
    if (!res.ok) { const e = new Error(`translate HTTP ${res.status}`); e.retry = true; throw e; }
    const j = await res.json();
    if (!Array.isArray(j?.[0])) throw new Error('translate: unexpected reply');
    lang ??= typeof j[2] === 'string' ? j[2] : null;
    for (const s of j[0]) if (typeof s?.[0] === 'string') segments.push([s[0], typeof s[1] === 'string' ? s[1] : '']);
  }
  return { lang, segments };
}

// Translate several fields in one request and give each its own translation back, using
// the original text Google echoes for every sentence to find where each field ends.
export async function translateFields(fields, fetchImpl = fetch) {
  const sep = '\n\n';
  const { lang, segments } = await translateText(fields.join(sep), fetchImpl);
  const ends = [];
  let at = 0;
  for (const f of fields) { at += f.length; ends.push(at); at += sep.length; }
  const out = fields.map(() => '');
  let pos = 0;
  for (const [tr, orig] of segments) {
    let i = ends.findIndex(e => pos < e);
    if (i < 0) i = fields.length - 1;
    out[i] += tr;
    pos += orig.length;
  }
  return { lang, fields: out.map(s => s.replace(/^\s+|\s+$/g, '')) };
}

const skip = lang => !lang || lang === 'en' || lang === 'vi' || lang === 'und';

export function startTranslator(db, log, readConfig, { fetchImpl = fetch, intervalMs = 20000, gapMs = 1200 } = {}) {
  initTranslations(db);
  const pick = db.prepare('select rowid rid, id, author, title, text from items where tr_done = 0 order by first_seen desc limit 25');
  const done = db.prepare('update items set tr_done = ?, tr_from = ?, tr_title = ?, tr_text = ? where id = ?');
  const ftsDel = db.prepare('delete from items_fts where rowid = ?');
  const ftsIns = db.prepare('insert into items_fts(rowid, author, title, text) values (?, ?, ?, ?)');
  let busy = false, pausedUntil = 0;
  async function tick() {
    if (busy || Date.now() < pausedUntil || readConfig().translation?.enabled === false) return 0;
    busy = true;
    let translated = 0;
    try {
      for (const r of pick.all()) {
        const title = r.title || '', text = r.text || '';
        if (!(title + text).trim() || isVietnamese(title, text) || looksEnglish(`${title}\n${text}`)) { done.run(1, null, null, null, r.id); continue; }
        let out;
        try { out = await translateFields([title, text], fetchImpl); }
        catch (e) {
          if (e.retry || e.name === 'TimeoutError' || e.name === 'TypeError') { pausedUntil = Date.now() + 10 * 60e3; log('translate paused 10 min:', e.message); break; }
          done.run(-1, null, null, null, r.id); continue;
        }
        if (skip(out.lang)) { done.run(1, null, null, null, r.id); continue; }
        const [t, x] = out.fields;
        done.run(1, out.lang, title ? t : null, text ? x : null, r.id);
        // Search finds the English the viewer shows.
        ftsDel.run(r.rid); ftsIns.run(r.rid, r.author || '', title ? t : '', text ? x : '');
        translated++;
        if (gapMs) await new Promise(f => setTimeout(f, gapMs));
      }
    } finally { busy = false; }
    if (translated) log('translated', translated);
    return translated;
  }
  if (intervalMs) { setInterval(() => tick().catch(e => log('translate error', e.message)), intervalMs).unref?.(); }
  return { tick };
}

// The expanded article of a translated post, in English; cached per post.
export async function translatedArticle(db, item, article, fetchImpl = fetch) {
  if (!item.tr_from || !article?.blocks) return article;
  const hit = db.prepare('select article from article_translations where item_id = ?').get(item.id);
  if (hit) return JSON.parse(hit.article);
  const texts = [article.title || '', ...article.blocks.map(b => b.text || b.alt || '')];
  const parts = [];
  // Several requests at most: group blocks so each request stays under the size limit.
  for (let i = 0; i < texts.length; ) {
    let j = i, size = 0;
    while (j < texts.length && (j === i || size + texts[j].length + 2 < CHUNK)) size += texts[j++].length + 2;
    const group = texts.slice(i, j);
    parts.push(...(group.some(s => s.trim()) ? (await translateFields(group, fetchImpl)).fields : group));
    i = j;
  }
  const out = { ...article, title: parts[0] || article.title, translatedFrom: languageName(item.tr_from),
    blocks: article.blocks.map((b, k) => b.text ? { ...b, text: parts[k + 1] || b.text } : b.alt ? { ...b, alt: parts[k + 1] || b.alt } : b) };
  db.prepare('insert or replace into article_translations(item_id, article) values (?, ?)').run(item.id, JSON.stringify(out));
  return out;
}
