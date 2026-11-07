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
