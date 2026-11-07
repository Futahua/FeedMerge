import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createManagement } from '../management.mjs';
import { initSources } from '../sources.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table items(id text primary key,saved int,ai_done int,cat_done int,cf_done int);
    create table labels(id integer primary key,layer text,name text,description text,keywords text,source text,created int);
    create table item_labels(item_id text,label_id int,prob real,source text,decided int,updated int,primary key(item_id,label_id));
    insert into items values('a',0,1,1,1),('b',0,1,1,1);
    insert into labels values(1,'story','One',null,null,'ai',1),(2,'story','Two',null,null,'ai',1);
    insert into item_labels values('a',1,.5,'ai',0,1),('b',2,1,'user',1,1);`);
  initSources(db);return { db, owner: createManagement(db) };
}

test('taxonomy editing and new story split preview/apply/revert preserve original identities',()=>{
  const {db,owner}=fixture();try{
    const edit=owner.preview('edit_label',{action:'update',id:1,name:'Renamed',keywords:['history']});
    assert.equal(db.prepare('select name from labels where id=1').get().name,'One');
    const edited=owner.apply(edit.preview_id);assert.equal(db.prepare('select keywords from labels where id=1').get().keywords,'["history"]');
    owner.undo(edited.receipt_id,true);assert.equal(db.prepare('select name from labels where id=1').get().name,'One');
    const split=owner.preview('story_edit',{action:'split',source_id:1,name:'Specific event',post_ids:['a']});
    const receipt=owner.apply(split.preview_id),newId=split.input.id;
    assert.equal(db.prepare('select count(*) n from item_labels where label_id=1').get().n,0);
    assert.equal(db.prepare('select decided from item_labels where label_id=?').get(newId).decided,1);
    assert.equal(db.prepare('select count(*) n from items').get().n,2);
    owner.undo(receipt.receipt_id,true);assert.equal(db.prepare('select count(*) n from labels where id=?').get(newId).n,0);
    assert.equal(db.prepare("select prob from item_labels where item_id='a' and label_id=1").get().prob,.5);
  }finally{db.close();}
});
test('collections are identity references, idempotent, reversible and protect later edits',()=>{
  const {db,owner}=fixture();try{
    const plan=owner.preview('collection_edit',{action:'create',name:'Reading'});const created=owner.apply(plan.preview_id);
    const id=plan.input.id;assert.equal(owner.collections()[0].name,'Reading');
    const addition=owner.apply(owner.preview('collection_edit',{action:'add',id,post_ids:['a','a','b']}).preview_id);
    assert.deepEqual(owner.collections()[0].post_ids,['a','b']);
    assert.throws(()=>owner.undo(created.receipt_id,true),/changed after/);
    owner.undo(addition.receipt_id,true);owner.undo(created.receipt_id,true);assert.equal(owner.collections().length,0);
    assert.equal(db.prepare('select count(*) n from items').get().n,2);
  }finally{db.close();}
});
test('story edits refuse stale membership changes and taxonomy ID reuse',()=>{
  const {db,owner}=fixture();try{
    const p=owner.preview('story_edit',{action:'create',name:'New',post_ids:['a']});
    db.prepare("insert into labels values(?,'story','Concurrent',null,null,'user',2)").run(p.input.id);
    assert.throws(()=>owner.apply(p.preview_id),/identity changed/);
    const split=owner.preview('story_edit',{action:'split',source_id:1,name:'Split',post_ids:['a']});
    db.prepare("update item_labels set decided=-1 where item_id='a' and label_id=1").run();
    assert.throws(()=>owner.apply(split.preview_id),/not in the source/);
  }finally{db.close();}
});
test('preview uses real mutation but rolls back; apply is idempotent and undo targets one receipt', () => {
  const { db, owner } = fixture();
  try {
    const plan = owner.preview('save_posts', { post_ids: ['a'], saved: true });
    assert.equal(db.prepare("select saved from items where id='a'").get().saved, 0);
    const result = owner.apply(plan.preview_id);
    assert.equal(owner.apply(plan.preview_id).receipt_id, result.receipt_id);
    db.prepare("update items set saved=1 where id='b'").run();
    assert(owner.undo(result.receipt_id).preview);
    owner.undo(result.receipt_id, true);
    assert.equal(db.prepare("select saved from items where id='a'").get().saved, 0);
    assert.equal(db.prepare("select saved from items where id='b'").get().saved, 1);
  } finally { db.close(); }
});

test('source edits are explicit, preserve captures and refuse stale undo after polling',()=>{
  const {db,owner}=fixture();try{
    const p=owner.preview('source_control',{action:'add',resolved:{kind:'feed',url:'https://example.test/feed',name:'Source'}});
    assert.equal(db.prepare('select count(*) n from sources').get().n,0);
    const r=owner.apply(p.preview_id,'source_control');assert.equal(db.prepare('select count(*) n from sources').get().n,1);
    assert.throws(()=>owner.apply(p.preview_id,'save_posts'),/different operation/);
    const pause=owner.apply(owner.preview('source_control',{action:'pause',id:1}).preview_id);assert.equal(db.prepare('select enabled from sources').get().enabled,0);
    owner.undo(pause.receipt_id,true);assert.equal(db.prepare('select enabled from sources').get().enabled,1);
    db.prepare('update sources set last_fetch=999 where id=1').run();
    assert.throws(()=>owner.undo(r.receipt_id,true),/changed after/);
  }finally{db.close();}
});
test('concurrent changes refuse stale apply and targeted undo', () => {
  const { db, owner } = fixture();
  try {
    const p = owner.preview('update_post_labels', { post_ids: ['a'], label_ids: [1], decision: 'confirm' });
    const r = owner.apply(p.preview_id);
    db.prepare("update item_labels set decided=-1,updated=999 where item_id='a'").run();
    assert.throws(() => owner.undo(r.receipt_id, true), /changed after/);
    const p2 = owner.preview('save_posts', { post_ids: ['a'], saved: true });
    db.prepare("update items set saved=1 where id='a'").run();
    assert.throws(() => owner.apply(p2.preview_id), /changed since/);
  } finally { db.close(); }
});
test('story merge preserves memberships and original IDs, and can reverse without global undo', () => {
  const { db, owner } = fixture();
  try {
    const p = owner.preview('merge_stories', { label_ids: [1,2], target_id: 1 });
    const r = owner.apply(p.preview_id);
    assert.equal(db.prepare('select count(*) n from labels').get().n, 2);
    assert.equal(db.prepare('select to_id from story_aliases where from_id=2').get().to_id, 1);
    assert.equal(db.prepare("select decided from item_labels where item_id='b' and label_id=1").get().decided, 1);
    owner.undo(r.receipt_id, true);
    assert.equal(db.prepare("select label_id from item_labels where item_id='b'").get().label_id, 2);
  } finally { db.close(); }
});
test('review is separate from confirmation; reclassification preserves manual labels and queues existing workers', () => {
  const { db, owner } = fixture();
  try {
    owner.apply(owner.preview('mark_posts_reviewed', { post_ids: ['a'] }).preview_id);
    assert.equal(db.prepare("select decided from item_labels where item_id='a'").get().decided, 0);
    const r = owner.apply(owner.preview('reclassify_posts', { post_ids: ['b'] }).preview_id);
    assert.equal(db.prepare("select cf_done from items where id='b'").get().cf_done, 0);
    assert.equal(db.prepare("select decided from item_labels where item_id='b'").get().decided, 1);
    assert.equal(owner.jobs()[0].pending, 1);
    assert.throws(() => owner.undo(r.receipt_id, true), /not reversible/);
  } finally { db.close(); }
});
