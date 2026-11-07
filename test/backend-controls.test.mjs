import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {CONTROL_CATALOG,normalizeControlChanges,applyControlOverrides,controlCatalog} from '../backend-controls.mjs';
import {createManagement} from '../management.mjs';

test('backend controls are discoverable and cannot edit secrets, authority or arbitrary settings',()=>{
 assert(Object.keys(CONTROL_CATALOG).length>=50);
 for(const patch of [{'ai.apiKey':'secret'},{'agent.writes':false},{'ai.baseUrl':'http://127.0.0.1'},{'ai.batchSize':100000},{'ai.temperature':NaN},{'capture.platforms.x.scrolls':100},{'retention.days':0}])assert.throws(()=>normalizeControlChanges(patch));
 assert.deepEqual(normalizeControlChanges({'ai.batchSize':5,'ai.enabled':false}),{'ai.batchSize':5,'ai.enabled':false});
});

test('settings preview/apply/undo preserve local secrets and detect both runtime and file changes',()=>{
 const db=new DatabaseSync(':memory:');let file={ai:{apiKey:'private',batchSize:25},cloudflare:{apiToken:'private'}};
 const read=()=>applyControlOverrides(db,file);const owner=createManagement(db,read);
 const p=owner.preview('backend_settings',{changes:{'ai.batchSize':5,'capture.platforms.pinterest.hours':18,'retention.days':14}});
 assert.equal(read().ai.batchSize,25);
 const r=owner.apply(p.preview_id,'backend_settings');assert.equal(read().ai.batchSize,5);assert.equal(read().ai.apiKey,'private');
 assert.equal(db.prepare("select v from meta where k='retention_days'").get().v,'14');
 assert(!JSON.stringify(controlCatalog(db,read())).includes('private'));
 owner.undo(r.receipt_id,true);assert.equal(read().ai.batchSize,25);
 const stale=owner.preview('backend_settings',{changes:{'ai.batchSize':10}});file.ai.batchSize=50;
 assert.throws(()=>owner.apply(stale.preview_id),/changed since/);
 const changed=owner.apply(owner.preview('backend_settings',{changes:{'ai.batchSize':12}}).preview_id);
 db.prepare("update meta set v='13' where k='control:ai.batchSize'").run();assert.throws(()=>owner.undo(changed.receipt_id,true),/changed after/);
 const reset=owner.apply(owner.preview('backend_settings',{changes:{'ai.batchSize':null}}).preview_id);assert.equal(read().ai.batchSize,50);
 owner.undo(reset.receipt_id,true);assert.equal(read().ai.batchSize,13);db.close();
});

test('backend jobs share the existing queue and can only be undone before work starts',()=>{
 const db=new DatabaseSync(':memory:'),owner=createManagement(db);
 const p=owner.preview('backend_job',{action:'reparse'});assert.equal(db.prepare('select count(*) n from agent_jobs').get().n,0);
 const r=owner.apply(p.preview_id,'backend_job','reparse');assert.equal(owner.jobs()[0].status,'queued');
 owner.undo(r.receipt_id,true);assert.equal(owner.jobs().length,0);
 const started=owner.apply(owner.preview('backend_job',{action:'expire'}).preview_id);
 db.prepare("insert into agent_job_runs(id,status,started) values (?,'running',?)").run(started.job_id,Date.now());
 assert.equal(owner.jobs()[0].status,'running');assert.throws(()=>owner.undo(started.receipt_id,true),/changed after/);
 assert.throws(()=>owner.preview('backend_job',{action:'shell'}),/Unknown/);db.close();
});
