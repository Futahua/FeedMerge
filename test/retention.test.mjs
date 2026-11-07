import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { expire, trimPlatform, purgeExcluded } from '../retention.mjs';
import {compileExclusions} from '../content-preferences.mjs';

const DAY = 86400e3, NOW = 100 * DAY;
test('literal content exclusions do not confuse whole words or execute regular expressions',()=>{
 const match=compileExclusions({blockedTerms:['anime','cartoon','C++'],blockedTopics:['Gaming']});
 assert(match({text:'New anime release'}));assert(match({title:'A cartoon.'}));
 assert(!match({text:'Cartoonish political speech'}));assert(!match({text:'AnimeX software'}));
 assert(match({text:'Nothing in text'},['gaming']));assert(!compileExclusions({blockedTerms:['.*']})({text:'anything'}));
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table items(id text primary key, context text, author text, title text, text text, flags text, last_seen int, saved int default 0);
    create virtual table items_fts using fts5(author, title, text);
    create table item_labels(item_id text, label_id int, decided int default 0);
    create table embeddings(item_id text primary key, vec blob);
    create table story_edges(a text, b text, sim real);
    create table post_reviews(item_id text primary key);
    create table articles(item_id text primary key, fetched_at int, ok int, blocks text, error text);
    create table item_accounts(item_id text, profile text, first_seen int, last_seen int, seen int, primary key (item_id, profile));
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

test('posts captured while navigating are removed unless engaged', () => {
  const db = fixture();
  db.exec("update items set context = 'thread' where id in ('fresh', 'oldSaved')");
  expire(db, { now: NOW });
  const left = db.prepare('select id from items').all().map(x => x.id);
  assert.ok(!left.includes('fresh'));
  assert.ok(left.includes('oldSaved'));
});

test('window is configurable and a second run changes nothing', () => {
  const db = fixture();
  db.exec("insert into meta values ('retention_days', '14')");
  assert.equal(expire(db, { now: NOW }).posts, 2); // old (10 days) is within 14 now
  assert.equal(expire(db, { now: NOW }).posts, 0);
});

test('explicit platform trim halves the total, protects reviewed/library posts and cleans dependent records',()=>{
 const db=fixture();db.exec("alter table items add column platform text; update items set platform='pinterest'; update items set platform='x' where id='pushedAgain'; insert into post_reviews values('fresh')");
 const r=trimPlatform(db,'pinterest');assert.equal(r.before,8);assert.equal(r.removed,4);assert.equal(r.after,4);
 const left=db.prepare('select id from items').all().map(x=>x.id);
 for(const id of ['fresh','oldSaved','oldInCollection','oldConfirmed','pushedAgain'])assert(left.includes(id));
 assert.equal(db.prepare("select count(*) n from embeddings where item_id not in (select id from items)").get().n,0);
 assert.equal(db.prepare('select count(*) n from items_fts').get().n,5);
});

test('explicit topic deletion cleans linked records including saved/collection matches and records removed IDs',()=>{
 const db=fixture();db.exec("create table labels(id integer primary key,layer text,name text); insert into labels values (1,'topic','Sports'),(2,'topic','Gaming'); update items set context='IGN' where id='oldInCollection'; insert into item_labels values ('oldSaved',1,1)");
 const r=purgeExcluded(db,{blockedTopics:['Gaming','Sports'],blockedSourceNames:['IGN']});
 assert.equal(r.removed,5);
 assert.equal(db.prepare('select count(*) n from content_removed').get().n,5);
 assert.equal(db.prepare('select count(*) n from collection_items').get().n,0);
 assert.equal(db.prepare('select count(*) n from items_fts').get().n,4);
 assert.equal(purgeExcluded(db,{blockedTopics:['Gaming','Sports'],blockedSourceNames:['IGN']}).removed,0);
 db.close();
});
