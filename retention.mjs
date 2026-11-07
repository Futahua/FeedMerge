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

const DAY = 86400e3;

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
        and (last_seen < ? or (coalesce(json_extract(flags, '$.ad'), 0) = 1 and last_seen < ?))`)
      .run(now - s.days * DAY, now - s.adDays * DAY);
    const posts = db.prepare('select count(*) n from expiring').get().n;
    if (posts) {
      db.exec(`
        delete from items_fts where rowid in (select rid from expiring);
        delete from item_labels where item_id in (select id from expiring);
        delete from embeddings where item_id in (select id from expiring);
        delete from story_edges where a in (select id from expiring) or b in (select id from expiring);
        delete from post_reviews where item_id in (select id from expiring);
        delete from items where id in (select id from expiring);`);
    }
    const raw = db.prepare('delete from raw where captured_at < ?').run(now - s.rawDays * DAY).changes;
    db.exec('delete from expiring');
    db.prepare("insert into meta(k, v) values ('retention_last', ?) on conflict(k) do update set v = excluded.v")
      .run(JSON.stringify({ at: now, posts, raw, ...s }));
    return { posts, raw, ...s };
  });
}
