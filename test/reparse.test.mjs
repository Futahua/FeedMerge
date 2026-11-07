import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { reparseCaptures } from '../reparse.mjs';
import { transaction } from '../sqlite-transaction.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table items(id text primary key, text text, ai_topics text, ai_story text, ai_done int, saved int, cf_done int, cat_done int);
    create virtual table items_fts using fts5(author, title, text);
    create table raw(id integer primary key, platform text, kind text, url text, page_url text, captured_at int, body blob);
    create table item_labels(item_id text, label_id int, decided int);
    insert into items values('a','original','topic','story',1,1,2,3);
    insert into items_fts(rowid,text) values(1,'original');
    insert into item_labels values('a',4,1);`);
  const raw = db.prepare("insert into raw values(?, 'web', 'links', '', '', 1, ?)");
  raw.run(1, gzipSync('replacement'));
  const ingest = cap => transaction(db, () => {
    db.prepare('insert into items(id,text) values(?,?)').run('a', cap.payload);
    db.prepare('insert into items_fts(rowid,text) values(1,?)').run(cap.payload);
  });
  return { db, raw, ingest };
}

test('corrupt later capture rolls back prior rebuild, FTS and saved classifications', () => {
  const { db, raw, ingest } = fixture();
  try {
    const before = db.prepare('select * from items').all();
    raw.run(2, Buffer.from('not gzip'));
    assert.throws(() => reparseCaptures(db, ingest));
    assert.deepEqual(db.prepare('select * from items').all(), before);
    assert.equal(db.prepare("select count(*) n from items_fts where items_fts match 'original'").get().n, 1);
    assert.equal(db.prepare('select decided from item_labels').get().decided, 1);
  } finally { db.close(); }
});

test('successful nested rebuild commits both indexes and retains saved/classifier state', () => {
  const { db, ingest } = fixture();
  try {
    assert.deepEqual(reparseCaptures(db, ingest), { captures: 1, items: 1, preserved: 0 });
    const item = db.prepare('select * from items').get();
    assert.equal(item.text, 'replacement');
    assert.equal(item.saved, 1);
    assert.equal(item.cat_done, 3);
    assert.equal(item.cf_done, 2);
    assert.equal(item.ai_story, 'story');
    assert.equal(db.prepare("select count(*) n from items_fts where items_fts match 'replacement'").get().n, 1);
  } finally { db.close(); }
});

test('posts without remaining captures are kept unchanged and searchable', () => {
  const { db } = fixture();
  try {
    const before = db.prepare('select * from items').get();
    assert.deepEqual(reparseCaptures(db, () => {}), { captures: 1, items: 1, preserved: 1 });
    assert.deepEqual(db.prepare('select * from items').get(), before);
    assert.equal(db.prepare("select count(*) n from items_fts where items_fts match 'original'").get().n, 1);
  } finally { db.close(); }
});
