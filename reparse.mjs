import { gunzipSync } from 'node:zlib';
import { transaction } from './sqlite-transaction.mjs';

// Never publish a partially rebuilt items/FTS pair, including on corrupt captures.
export function reparseCaptures(db, ingest) {
  return transaction(db, () => {
    const keep = db.prepare('select id, ai_topics, ai_story, ai_done, saved, cf_done, cat_done from items').all();
    db.exec('delete from items; delete from items_fts;');
    const ids = db.prepare('select id from raw order by id').all();
    const one = db.prepare('select * from raw where id = ?');
    for (const { id } of ids) {
      const r = one.get(id);
      ingest({ platform: r.platform, kind: r.kind, url: r.url, pageUrl: r.page_url, capturedAt: r.captured_at,
        payload: gunzipSync(r.body).toString('utf8') }, false, true);
    }
    const restore = db.prepare('update items set ai_topics = ?, ai_story = ?, ai_done = ?, saved = ?, cf_done = ?, cat_done = ? where id = ?');
    const present = db.prepare('select id from items where id = ?');
    const missing = keep.filter(k => !present.get(k.id));
    if (missing.length) throw new Error(`Reparse would remove ${missing.length} existing posts; rebuild refused. Original data retained.`);
    for (const k of keep) restore.run(k.ai_topics, k.ai_story, k.ai_done, k.saved, k.cf_done ?? 0, k.cat_done ?? 0, k.id);
    return { captures: ids.length, items: db.prepare('select count(*) n from items').get().n };
  });
}
