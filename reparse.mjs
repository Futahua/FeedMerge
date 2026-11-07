import { gunzipSync } from 'node:zlib';
import { transaction } from './sqlite-transaction.mjs';

// Never publish a partially rebuilt items/FTS pair, including on corrupt captures.
export function reparseCaptures(db, ingest) {
  return transaction(db, () => {
    // Full rows, so posts whose raw captures were already trimmed (retention.mjs) can be kept
    // exactly as they are; only posts the remaining captures produce are rebuilt.
    const keep = db.prepare('select * from items').all();
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
    // Posts no remaining capture produces (their raw data has expired) are put back unchanged,
    // with a fresh search entry, so a rebuild never loses a post.
    const columns = Object.keys(keep[0] || {});
    const putBack = columns.length && db.prepare(`insert into items(${columns.join(',')}) values (${columns.map(() => '?').join(',')})`);
    const fts = db.prepare('insert into items_fts(rowid, author, title, text) values (?, ?, ?, ?)');
    let preserved = 0;
    for (const k of keep) {
      if (present.get(k.id)) { restore.run(k.ai_topics, k.ai_story, k.ai_done, k.saved, k.cf_done ?? 0, k.cat_done ?? 0, k.id); continue; }
      const r = putBack.run(...columns.map(c => k[c]));
      fts.run(r.lastInsertRowid, k.author || '', k.title || '', k.text || '');
      preserved++;
    }
    return { captures: ids.length, items: db.prepare('select count(*) n from items').get().n, preserved };
  });
}
