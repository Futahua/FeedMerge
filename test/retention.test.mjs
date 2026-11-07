import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { expire } from '../retention.mjs';

const DAY = 86400e3, NOW = 100 * DAY;
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table items(id text primary key, author text, title text, text text, flags text, last_seen int, saved int default 0);
    create virtual table items_fts using fts5(author, title, text);
    create table item_labels(item_id text, label_id int, decided int default 0);
    create table embeddings(item_id text primary key, vec blob);
    create table story_edges(a text, b text, sim real);
    create table post_reviews(item_id text primary key);
    create table collection_items(collection_id text, item_id text);
    create table raw(id integer primary key, captured_at int, body blob);
    create table meta(k text primary key, v text);`);
  const add = (id, daysAgo, extra = {}) => {
    const r = db.prepare('insert into items(id, text, flags, last_seen, saved) values (?, ?, ?, ?, ?)')
      .run(id, 'text ' + id, JSON.stringify(extra.ad ? { ad: 1 } : {}), NOW - daysAgo * DAY, extra.saved ? 1 : 0);
    db.prepare('insert into items_fts(rowid, text) values (?, ?)').run(r.lastInsertRowid, 'text ' + id);
    db.prepare('insert into embeddings values (?, ?)').run(id, Buffer.alloc(4));
  };
  add('fresh', 2); add('old', 10); add('oldSaved', 30, { saved: true }); add('oldInCollection', 30); add('oldConfirmed', 30);
  add('oldRejectedOnly', 30); add('adToday', 0.5, { ad: true }); add('adOld', 2, { ad: true }); add('pushedAgain', 1);
  db.exec(`insert into collection_items values ('c', 'oldInCollection');
    insert into item_labels values ('oldConfirmed', 1, 1), ('oldRejectedOnly', 1, -1), ('old', 2, 0), ('fresh', 2, 0);
    insert into story_edges values ('old', 'fresh', 0.9);
    insert into raw values (1, ${NOW - 1 * DAY}, x''), (2, ${NOW - 5 * DAY}, x'');`);
  return db;
}

test('expires untouched and ad posts, keeps the library and anything still being shown', () => {
  const db = fixture();
  const r = expire(db, { now: NOW });
  const left = db.prepare('select id from items order by id').all().map(x => x.id);
  assert.deepEqual(left, ['adToday', 'fresh', 'oldConfirmed', 'oldInCollection', 'oldSaved', 'pushedAgain']);
  assert.equal(r.posts, 3); // old, oldRejectedOnly, adOld
  assert.equal(r.raw, 1);
  for (const table of ['embeddings', 'item_labels', 'post_reviews']) {
    assert.equal(db.prepare(`select count(*) n from ${table} where item_id in ('old','adOld','oldRejectedOnly')`).get().n, 0, table);
  }
  assert.equal(db.prepare('select count(*) n from story_edges').get().n, 0);
  assert.equal(db.prepare("select count(*) n from items_fts where items_fts match 'old'").get().n, 0);
  assert.equal(db.prepare("select count(*) n from items_fts where items_fts match 'fresh'").get().n, 1);
});

test('window is configurable and a second run changes nothing', () => {
  const db = fixture();
  db.exec("insert into meta values ('retention_days', '14')");
  assert.equal(expire(db, { now: NOW }).posts, 2); // old (10 days) is within 14 now
  assert.equal(expire(db, { now: NOW }).posts, 0);
});
