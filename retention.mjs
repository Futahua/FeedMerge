// Feed retention: FeedMerge is for staying current, not for hoarding.
//
// - A post nobody engaged with is deleted once no feed has shown it for `days` (default 7).
//   last_seen is used, so a post the algorithms keep pushing stays while it is still current.
// - Engaged posts form the library and are kept: saved, in a collection, or with a label
//   you confirmed by hand.
// - Ads go after `adDays` (default 1) unless saved.
// - Raw captures go after `rawDays` (default 3): enough to rebuild recent posts after a
//   parser fix. Older posts are kept as they are by reparse (see reparse.mjs).
// Everything for a deleted post goes with it in one transaction: labels, embedding, story
// edges, review marks and its search entry. Settings: meta keys retention_days,
// retention_raw_days, retention_ad_days, or the FEEDMERGE_RETENTION_* environment variables.
import { transaction } from './sqlite-transaction.mjs';
import {initContentPreferences,contentExclusionSql} from './content-preferences.mjs';

const DAY = 86400e3;

// Capture contexts that come from navigating rather than from a feed: never stored, and
// removed by expire() (unless engaged).
export const NAVIGATION = new Set(['thread', 'profile', 'search']);

export function retentionSettings(db) {
  const meta = k => db.prepare('select v from meta where k = ?').get(k)?.v;
  const num = (env, key, fallback) => {
    const v = Number(process.env[env] ?? meta(key) ?? fallback);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    days: num('FEEDMERGE_RETENTION_DAYS', 'retention_days', 7),
    rawDays: num('FEEDMERGE_RETENTION_RAW_DAYS', 'retention_raw_days', 3),
    adDays: num('FEEDMERGE_RETENTION_AD_DAYS', 'retention_ad_days', 1),
  };
}

const ENGAGED = `(items.saved = 1
  or exists (select 1 from collection_items ci where ci.item_id = items.id)
  or exists (select 1 from item_labels il where il.item_id = items.id and il.decided = 1))`;

export function expire(db, { now = Date.now(), ...override } = {}) {
  const s = { ...retentionSettings(db), ...override };
  return transaction(db, () => {
    db.exec('create temp table if not exists expiring(id text primary key, rid integer)');
    db.exec('delete from expiring');
    db.prepare(`insert into expiring(id, rid)
      select id, rowid from items
      where not ${ENGAGED}
        and (last_seen < ? or (coalesce(json_extract(flags, '$.ad'), 0) = 1 and last_seen < ?)
             or context in (${[...NAVIGATION].map(() => '?').join(',')}))`)
      .run(now - s.days * DAY, now - s.adDays * DAY, ...NAVIGATION);
    const posts = db.prepare('select count(*) n from expiring').get().n;
    deleteExpiring(db, posts);
    const raw = db.prepare('delete from raw where captured_at < ?').run(now - s.rawDays * DAY).changes;
    db.exec('delete from expiring');
    db.prepare("insert into meta(k, v) values ('retention_last', ?) on conflict(k) do update set v = excluded.v")
      .run(JSON.stringify({ at: now, posts, raw, ...s }));
    return { posts, raw, ...s };
  });
}

function deleteExpiring(db, posts) {
  if (posts) {
      db.exec(`
        delete from items_fts where rowid in (select rid from expiring);
        delete from item_labels where item_id in (select id from expiring);
        delete from embeddings where item_id in (select id from expiring);
        delete from story_edges where a in (select id from expiring) or b in (select id from expiring);
        delete from post_reviews where item_id in (select id from expiring);
        delete from articles where item_id in (select id from expiring);
        delete from item_accounts where item_id in (select id from expiring);
        delete from collection_items where item_id in (select id from expiring);
        delete from items where id in (select id from expiring);`);
      try { db.exec('delete from article_translations where item_id in (select id from expiring)'); } catch {}
    }
}

// Explicit one-off trim, through the same transactional deletion owner as expiry.
export function trimPlatform(db, platform, fraction = .5) {
  if (typeof platform !== 'string' || !platform || !(fraction > 0 && fraction < 1)) throw new Error('Invalid trim');
  return transaction(db, () => {
    const before = db.prepare('select count(*) n from items where platform = ?').get(platform).n;
    const requested = Math.floor(before * fraction);
    db.exec('create temp table if not exists expiring(id text primary key, rid integer)');
    db.exec('delete from expiring');
    db.prepare(`insert into expiring select id, rowid from items where platform = ? and not ${ENGAGED}
      and not exists (select 1 from post_reviews pr where pr.item_id = items.id)
      order by last_seen, rowid limit ?`).run(platform, requested);
    const removed = db.prepare('select count(*) n from expiring').get().n;
    deleteExpiring(db, removed);
    db.exec('delete from expiring');
    return { platform, before, removed, after: before - removed, requested };
  });
}

// Web language balance: Vietnamese makes up `percent` of web posts. Other-language web posts
// beyond that share are deleted, oldest first within each source so every source keeps its
// newest posts, and recorded as removed so a later poll does not bring them back. Wikipedia
// picks and the library (saved, collected, confirmed) are never trimmed.
// The returned `admit` is the share of new other-language web posts ingest should keep, so
// fewer are collected in the first place; it adjusts each run toward the target.
const VI_LETTERS = /[ăắằẳẵặơớờởỡợưứừửữựđạảấầẩẫậẹẻẽếềểễệỉịọỏốồổỗộụủỳỵỷỹ]/gi;
export function isVietnamese(title, text) {
  const s = `${title || ''} ${text || ''}`;
  const n = (s.match(VI_LETTERS) || []).length;
  return n >= 3 || (n >= 1 && s.length < 80);
}
const WIKIPEDIA = 'Wikipedia · ';
export function admitsWebPost(id, admit) {
  if (!(admit < 1)) return true;
  let h = 2166136261; // FNV-1a: the same post always gets the same answer
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296 < admit;
}
export function balanceWebLanguages(db, percent = 67) {
  if (!(percent > 0 && percent < 100)) return { removed: 0, admit: 1 };
  return transaction(db, () => {
    const rows = db.prepare(`select id, rowid rid, context, title, text, last_seen, ${ENGAGED} engaged from items where platform = 'web'`).all();
    let vietnamese = 0;
    const others = [];
    for (const r of rows) {
      if (isVietnamese(r.title, r.text)) vietnamese++;
      else if (!String(r.context || '').startsWith(WIKIPEDIA)) others.push(r);
    }
    const allowed = Math.floor(vietnamese * (100 - percent) / percent);
    const prev = Number(db.prepare("select v from meta where k = 'web_other_admit'").get()?.v ?? 1);
    // Multiplicative step toward the target, at most 4x down or 1.25x up per run.
    const admit = Math.min(1, Math.max(0.02, prev * Math.min(1.25, Math.max(0.25, others.length ? allowed / others.length : 1.25))));
    db.prepare("insert into meta(k, v) values ('web_other_admit', ?) on conflict(k) do update set v = excluded.v").run(String(admit));
    const excess = others.length - allowed;
    if (excess <= 0) return { vietnamese, others: others.length, removed: 0, admit };
    // Rank each post by how far down its own source it sits (0 newest .. 1 oldest).
    const bySource = new Map();
    for (const r of others) (bySource.get(r.context) || bySource.set(r.context, []).get(r.context)).push(r);
    const candidates = [];
    for (const list of bySource.values()) {
      list.sort((a, b) => b.last_seen - a.last_seen || b.rid - a.rid);
      list.forEach((r, i) => { if (!r.engaged) candidates.push({ r, depth: list.length > 1 ? i / (list.length - 1) : 0 }); });
    }
    candidates.sort((a, b) => b.depth - a.depth || a.r.last_seen - b.r.last_seen);
    const doomed = candidates.slice(0, excess).map(c => c.r);
    db.exec('create temp table if not exists expiring(id text primary key, rid integer); delete from expiring');
    const put = db.prepare('insert into expiring(id, rid) values (?, ?)');
    for (const r of doomed) put.run(r.id, r.rid);
    db.exec('create table if not exists content_removed(id text primary key, removed_at integer)');
    db.prepare('insert or ignore into content_removed select id, ? from expiring').run(Date.now());
    deleteExpiring(db, doomed.length);
    db.exec('delete from expiring');
    return { vietnamese, others: others.length, removed: doomed.length, admit };
  });
}

// Explicit user exclusions also apply to saved/reviewed matches. Caller takes a backup.
export function purgeExcluded(db,policy={}) {
 initContentPreferences(db);
 const filter=contentExclusionSql(policy);
 return transaction(db,()=>{
   db.exec('create temp table if not exists expiring(id text primary key,rid integer); delete from expiring');
   db.prepare('insert into expiring select id,rowid from items where '+filter.sql).run(...filter.args);
   const removed=db.prepare('select count(*) n from expiring').get().n;
   db.prepare('insert or ignore into content_removed select id,? from expiring').run(Date.now());
   deleteExpiring(db,removed);db.exec('delete from expiring');return {removed};
 });
}
