// Posts in languages other than English and Vietnamese are shown in English, with a note of
// the original language; the original stays stored (so re-captures and filters still work)
// but is not shown. Uses Google Translate's free web endpoint: hosted, no key, many texts per
// request, and it reports each text's language. Vietnamese and obviously English posts never
// leave the machine. tr_done: 0 pending, 1 handled, -1 gave up on this post.
import { isVietnamese } from './retention.mjs';

// Two hosts serve the same endpoint with separate rate limits; the second is the fallback.
const ENDPOINTS = ['https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=en',
  'https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=en'];
const PER_TEXT = 10000, PER_REQUEST = 30000, TEXTS = 60;
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

// One request for many texts: [{ text, lang }] in the same order. Empty texts are not sent.
export async function translateBatch(texts, fetchImpl = fetch) {
  const sent = texts.map((t, i) => [i, t]).filter(([, t]) => t && t.trim());
  const out = texts.map(t => ({ text: t, lang: null }));
  if (!sent.length) return out;
  const body = new URLSearchParams();
  for (const [, t] of sent) body.append('q', t.slice(0, PER_TEXT));
  let j, last;
  for (const url of ENDPOINTS) {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body, signal: AbortSignal.timeout(30000) });
    if (res.ok) { j = await res.json(); break; }
    last = res.status;
  }
  if (!j) { const e = new Error(`translate HTTP ${last}`); e.retry = true; throw e; }
  // A single text comes back as [text, lang] rather than [[text, lang]].
  const rows = sent.length === 1 && typeof j[0] === 'string' ? [j] : j;
  if (!Array.isArray(rows) || rows.length !== sent.length) throw new Error('translate: unexpected reply');
  sent.forEach(([i, t], k) => {
    const row = rows[k];
    out[i] = Array.isArray(row) ? { text: String(row[0] ?? t), lang: typeof row[1] === 'string' ? row[1] : null } : { text: String(row ?? t), lang: null };
  });
  return out;
}

const skip = lang => !lang || lang === 'en' || lang === 'vi' || lang === 'und';
const same = (a, b) => String(a || '').replace(/\s+/g, ' ').trim().toLowerCase() === String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();

export function startTranslator(db, log, readConfig, { fetchImpl = fetch, intervalMs = 10000 } = {}) {
  initTranslations(db);
  const pick = db.prepare('select rowid rid, id, author, title, text from items where tr_done = 0 order by first_seen desc');
  const done = db.prepare('update items set tr_done = ?, tr_from = ?, tr_title = ?, tr_text = ? where id = ?');
  const ftsDel = db.prepare('delete from items_fts where rowid = ?');
  const ftsIns = db.prepare('insert into items_fts(rowid, author, title, text) values (?, ?, ?, ?)');
  let busy = false, pausedUntil = 0;
  async function tick() {
    if (busy || Date.now() < pausedUntil || readConfig().translation?.enabled === false) return 0;
    busy = true;
    let translated = 0;
    try {
      // Posts that need no request are settled right away; the rest go in one batched request.
      const batch = [];
      let size = 0, full = false;
      for (const r of pick.iterate()) {
        const title = r.title || '', text = r.text || '';
        if (!(title + text).trim() || isVietnamese(title, text) || looksEnglish(`${title}\n${text}`)) { done.run(1, null, null, null, r.id); continue; }
        if (full) continue;
        const n = Math.min(title.length, PER_TEXT) + Math.min(text.length, PER_TEXT);
        if (batch.length && (batch.length * 2 + 2 > TEXTS || size + n > PER_REQUEST)) { full = true; continue; }
        batch.push(r); size += n;
      }
      if (!batch.length) return 0;
      let res;
      try { res = await translateBatch(batch.flatMap(r => [r.title || '', r.text || '']), fetchImpl); }
      catch (e) {
        if (e.retry || e.name === 'TimeoutError' || e.name === 'TypeError') { pausedUntil = Date.now() + 10 * 60e3; log('translate paused 10 min:', e.message); return 0; }
        for (const r of batch) done.run(-1, null, null, null, r.id);
        log('translate failed:', e.message);
        return 0;
      }
      batch.forEach((r, k) => {
        const t = res[2 * k], x = res[2 * k + 1];
        // The language of the longer field speaks for the post.
        const lang = (r.text || '').length >= (r.title || '').length ? (x.lang || t.lang) : (t.lang || x.lang);
        // Hashtags, names and links come back unchanged: nothing was translated.
        if (skip(lang) || (same(t.text, r.title) && same(x.text, r.text))) { done.run(1, null, null, null, r.id); return; }
        const title = r.title ? t.text : null, text = r.text ? x.text : null;
        done.run(1, lang, title, text, r.id);
        // Search finds the English the viewer shows.
        ftsDel.run(r.rid); ftsIns.run(r.rid, r.author || '', title || '', text || '');
        translated++;
      });
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
  for (let i = 0; i < texts.length; ) {
    let j = i, size = 0;
    while (j < texts.length && j - i < TEXTS && (j === i || size + texts[j].length < PER_REQUEST)) size += texts[j++].length;
    parts.push(...(await translateBatch(texts.slice(i, j), fetchImpl)).map(r => r.text));
    i = j;
  }
  const out = { ...article, title: parts[0] || article.title, translatedFrom: languageName(item.tr_from),
    blocks: article.blocks.map((b, k) => b.text ? { ...b, text: parts[k + 1] || b.text } : b.alt ? { ...b, alt: parts[k + 1] || b.alt } : b) };
  db.prepare('insert or replace into article_translations(item_id, article) values (?, ?)').run(item.id, JSON.stringify(out));
  return out;
}
