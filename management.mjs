import { normalizeRules } from './source-rules.mjs';
import { randomUUID } from 'node:crypto';
import { transaction } from './sqlite-transaction.mjs';

const fail = message => Object.assign(new Error(message), { status: 409 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const operations = new Set(['update_post_labels', 'mark_posts_reviewed', 'merge_stories', 'reclassify_posts', 'save_posts', 'source_control','edit_label','story_edit','collection_edit']);
function ids(input, field, numeric = false) {
  const values = input[field];
  if (!Array.isArray(values) || !values.length || values.length > 100) throw fail(`${field} requires 1–100 explicit IDs.`);
  if (values.some(x => numeric ? !Number.isSafeInteger(x) || x < 1 : typeof x !== 'string' || !x || x.length > 256)) throw fail(`Invalid ${field}.`);
  return [...new Set(values)].sort(numeric ? (a, b) => a - b : undefined);
}

export function createManagement(db) {
  db.exec(`create table if not exists agent_previews(id text primary key, operation text, input text, before_json text, created integer, expires integer);
    create table if not exists agent_receipts(id text primary key, preview_id text unique, operation text, input text, before_json text, after_json text, created integer, undone integer);
    create table if not exists post_reviews(item_id text primary key, reviewed_at integer, actor text);
    create table if not exists story_aliases(from_id integer primary key, to_id integer);
    create table if not exists agent_jobs(id text primary key, kind text, input text, created integer);
    create table if not exists collections(id text primary key,name text,description text,created integer);
    create table if not exists collection_items(collection_id text,item_id text,primary key(collection_id,item_id));`);

  function normalize(operation, input) {
    if (!operations.has(operation)) throw fail('Unsupported management operation.');
    if(operation==='collection_edit'){
      if(!['create','rename','add','remove','delete'].includes(input.action))throw fail('Unknown collection action.');
      const id=input.id||randomUUID(),existing=db.prepare('select * from collections where id=?').get(id);
      if(input.action==='create'?existing:!existing)throw fail('Collection identity changed or missing.');
      const post_ids=['add','remove'].includes(input.action)?ids(input,'post_ids'):[];
      for(const post of post_ids)if(!db.prepare('select id from items where id=?').get(post))throw fail('Post not found.');
      if(['create','rename'].includes(input.action)&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>120))throw fail('Collection name requires 1–120 characters.');
      return {action:input.action,id,post_ids,name:input.name?.trim(),description:typeof input.description==='string'?input.description.slice(0,1000):''};
    }
    if(operation==='edit_label'||operation==='story_edit'){
      const creating=operation==='story_edit'||input.action==='create';
      if(operation==='edit_label'&&!['create','update'].includes(input.action))throw fail('Choose create or update.');
      const id=input.id??(db.prepare('select coalesce(max(id),0)+1 id from labels').get().id),existing=db.prepare('select * from labels where id=?').get(id);
      if(!Number.isSafeInteger(id)||id<1||(creating?existing:!existing))throw fail('Label identity changed or missing.');
      const layer=operation==='story_edit'?'story':creating?input.layer:existing.layer;
      if(!['topic','story','place','entity','format'].includes(layer))throw fail('Unknown taxonomy layer.');
      if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80)throw fail('Name requires 1–80 characters.');
      const name=input.name.trim();if(db.prepare('select id from labels where layer=? and name=? and id!=?').get(layer,name,id))throw fail('Name already exists in this layer.');
      if(input.keywords!==undefined&&(!Array.isArray(input.keywords)||input.keywords.length>30||input.keywords.some(x=>typeof x!=='string'||!x.trim()||x.length>60)))throw fail('Invalid keywords.');
      let oldKeywords=[];try{oldKeywords=JSON.parse(existing?.keywords||'[]');}catch{}
      const normalized={id,creating,action:creating?'create':'update',layer,name,description:input.description===undefined?(existing?.description||''):String(input.description).slice(0,300),keywords:input.keywords===undefined?oldKeywords:input.keywords};
      if(operation==='story_edit'){
        if(!['create','split'].includes(input.action))throw fail('Choose create or split.');
        normalized.action=input.action;normalized.post_ids=ids(input,'post_ids');
        for(const post of normalized.post_ids)if(!db.prepare('select id from items where id=?').get(post))throw fail('Post not found.');
        if(input.action==='split'){
          const source=db.prepare("select id from labels where id=? and layer='story'").get(input.source_id);
          if(!source||db.prepare('select from_id from story_aliases where from_id=?').get(source.id))throw fail('Choose a canonical source story.');
          for(const post of normalized.post_ids)if(!db.prepare('select item_id from item_labels where item_id=? and label_id=? and decided>=0').get(post,source.id))throw fail('Selected post is not in the source story.');
          normalized.source_id=source.id;
        }
      }
      return normalized;
    }
    if(operation==='source_control'){
      if(!['add','pause','resume','remove','refresh','configure','capture'].includes(input.action))throw fail('Unknown source action.');
      if(input.action==='add'){
        const resolved=input.resolved;if(!resolved||!['feed','page','rendered'].includes(resolved.kind)||typeof resolved.url!=='string'||typeof resolved.name!=='string')throw fail('Source must be resolved by the fetch owner first.');
        if(db.prepare('select id from sources where url=?').get(resolved.url))throw fail('Source already exists.');
        const id=input.id??(db.prepare('select coalesce(max(id),0)+1 id from sources').get().id);
        if(!Number.isSafeInteger(id)||db.prepare('select id from sources where id=?').get(id))throw fail('Source ID changed.');
        return {action:'add',id,resolved:{url:resolved.url,kind:resolved.kind,name:resolved.name.slice(0,120)},interval:Math.max(10,Math.min(10080,Number(input.interval)||30))};
      }
      if(!Number.isSafeInteger(input.id)||!db.prepare('select id from sources where id=?').get(input.id))throw fail('Source not found.');
      if(input.action==='configure') {
        if(!['page','rendered'].includes(input.mode))throw fail('Choose page or rendered mode.');
        const rules=normalizeRules(input.rules);
        if(input.mode==='page' && rules.linkSelector!=='a[href]')throw fail('CSS selectors require rendered mode.');
        return {action:input.action,id:input.id,mode:input.mode,rules};
      }
      if(input.action==='capture') {
        const src=db.prepare('select kind,enabled from sources where id=?').get(input.id);
        if(src.kind!=='rendered'||!src.enabled)throw fail('Browser capture requires an enabled rendered source. Configure it first.');
      }
      return {action:input.action,id:input.id};
    }
    if (operation === 'merge_stories') {
      const label_ids = ids(input, 'label_ids', true);
      if (label_ids.length < 2 || !label_ids.includes(input.target_id)) throw fail('Choose at least two stories and a target from them.');
      for (const id of label_ids) if (!db.prepare("select id from labels where id = ? and layer = 'story'").get(id)) throw fail('Story not found.');
      for (const id of label_ids) if (db.prepare('select from_id from story_aliases where from_id=?').get(id)) throw fail('Choose canonical stories, not merged aliases.');
      return { label_ids, target_id: input.target_id };
    }
    const post_ids = ids(input, 'post_ids');
    for (const id of post_ids) if (!db.prepare('select id from items where id = ?').get(id)) throw fail('Post not found.');
    if (operation === 'update_post_labels') {
      const label_ids = ids(input, 'label_ids', true);
      for (const id of label_ids) if (!db.prepare('select id from labels where id = ?').get(id)) throw fail('Label not found.');
      if (!['confirm', 'reject', 'pending', 'remove'].includes(input.decision)) throw fail('Choose confirm, reject, pending or remove.');
      return { post_ids, label_ids, decision: input.decision };
    }
    if (operation === 'save_posts') {
      if (typeof input.saved !== 'boolean') throw fail('saved must be a boolean.');
      return { post_ids, saved: input.saved };
    }
    return { post_ids };
  }

  // Capture only the rows/columns this operation owns. Restore never replaces whole tables.
  function snapshot(operation, input) {
    const out = {};
    if(operation==='collection_edit')return {collections:db.prepare('select * from collections where id=?').all(input.id),collection_items:db.prepare('select * from collection_items where collection_id=? order by item_id').all(input.id)};
    if(operation==='edit_label'||operation==='story_edit'){
      const keys=[input.id,...input.source_id?[input.source_id]:[]];
      return {labels:keys.flatMap(id=>db.prepare('select * from labels where id=?').all(id)),item_labels:keys.flatMap(id=>db.prepare('select * from item_labels where label_id=? order by item_id').all(id)),story_aliases:keys.flatMap(id=>db.prepare('select * from story_aliases where from_id=? or to_id=? order by from_id').all(id,id))};
    }
    if(operation==='source_control')return {sources:db.prepare('select * from sources where id=?').all(input.id)};
    if (operation === 'merge_stories') {
      out.labels = input.label_ids.map(id => db.prepare('select * from labels where id = ?').get(id));
      out.item_labels = input.label_ids.flatMap(id => db.prepare('select * from item_labels where label_id = ? order by item_id').all(id));
      out.story_aliases = input.label_ids.flatMap(id => db.prepare('select * from story_aliases where from_id = ?').all(id));
    } else if (operation === 'update_post_labels') {
      out.item_labels = input.post_ids.flatMap(id => input.label_ids.flatMap(label => db.prepare('select * from item_labels where item_id = ? and label_id = ?').all(id, label)));
    } else if (operation === 'mark_posts_reviewed') {
      out.post_reviews = input.post_ids.flatMap(id => db.prepare('select * from post_reviews where item_id = ?').all(id));
    } else {
      const columns = operation === 'save_posts' ? 'id, saved' : 'id, ai_done, cat_done, cf_done';
      out.items = input.post_ids.map(id => db.prepare(`select ${columns} from items where id = ?`).get(id));
    }
    return out;
  }

  function mutate(operation, input, stamp) {
    if(operation==='collection_edit'){
      if(input.action==='create')db.prepare('insert into collections values (?,?,?,?)').run(input.id,input.name,input.description,stamp);
      if(input.action==='rename')db.prepare('update collections set name=? where id=?').run(input.name,input.id);
      if(input.action==='delete'){db.prepare('delete from collection_items where collection_id=?').run(input.id);db.prepare('delete from collections where id=?').run(input.id);}
      for(const post of input.post_ids){if(input.action==='add')db.prepare('insert or ignore into collection_items values (?,?)').run(input.id,post);if(input.action==='remove')db.prepare('delete from collection_items where collection_id=? and item_id=?').run(input.id,post);}
    }else if(operation==='edit_label'||operation==='story_edit'){
      if(input.creating)db.prepare("insert into labels(id,layer,name,description,keywords,source,created) values (?,?,?,?,?,'user',?)").run(input.id,input.layer,input.name,input.description,JSON.stringify(input.keywords),stamp);
      else db.prepare("update labels set name=?,description=?,keywords=?,source='user' where id=?").run(input.name,input.description,JSON.stringify(input.keywords),input.id);
      if(operation==='story_edit')for(const post of input.post_ids){
        if(input.source_id)db.prepare('delete from item_labels where item_id=? and label_id=?').run(post,input.source_id);
        db.prepare("insert into item_labels values (?,?,1,'user',1,?)").run(post,input.id,stamp);
      }
    }else if(operation==='source_control'){
      if(input.action==='add')db.prepare('insert into sources(id,kind,name,url,interval_min,created) values (?,?,?,?,?,?)').run(input.id,input.resolved.kind,input.resolved.name,input.resolved.url,input.interval,stamp);
      else if(input.action==='remove')db.prepare('delete from sources where id=?').run(input.id);
      else if(input.action==='configure')db.prepare('update sources set kind=?,extraction_rules=?,last_fetch=null,last_hash=null where id=?').run(input.mode,JSON.stringify(input.rules),input.id);
      else if(input.action==='refresh'||input.action==='capture')db.prepare('update sources set last_fetch=null,last_hash=null where id=?').run(input.id);
      else db.prepare('update sources set enabled=? where id=?').run(input.action==='resume'?1:0,input.id);
    } else if (operation === 'update_post_labels') {
      for (const post of input.post_ids) for (const label of input.label_ids) {
        if (input.decision === 'remove') db.prepare('delete from item_labels where item_id = ? and label_id = ?').run(post, label);
        else {
          const decided = { confirm: 1, reject: -1, pending: 0 }[input.decision];
          db.prepare(`insert into item_labels values (?, ?, ?, 'user', ?, ?)
            on conflict(item_id,label_id) do update set prob=excluded.prob,source='user',decided=excluded.decided,updated=excluded.updated`)
            .run(post, label, decided === 1 ? 1 : 0, decided, stamp);
        }
      }
    } else if (operation === 'mark_posts_reviewed') {
      for (const id of input.post_ids) db.prepare("insert into post_reviews values (?, ?, 'agent') on conflict(item_id) do update set reviewed_at=excluded.reviewed_at,actor=excluded.actor").run(id, stamp);
    } else if (operation === 'save_posts') {
      for (const id of input.post_ids) db.prepare('update items set saved = ? where id = ?').run(Number(input.saved), id);
    } else if (operation === 'reclassify_posts') {
      // The existing classifiers consume these flags and retain decided assignments.
      for (const id of input.post_ids) db.prepare('update items set ai_done=0,cat_done=0,cf_done=0 where id=?').run(id);
    } else {
      const all = snapshot(operation, input).item_labels;
      const memberships = new Map();
      for (const row of all) {
        const previous = memberships.get(row.item_id);
        if (previous && previous.decided !== 0 && row.decided !== 0 && previous.decided !== row.decided) throw fail('Story membership decisions conflict; resolve them before merging.');
        if (!previous || previous.decided === 0 && (row.decided !== 0 || row.prob > previous.prob)) memberships.set(row.item_id, row);
      }
      for (const id of input.label_ids) db.prepare('delete from item_labels where label_id=?').run(id);
      for (const row of memberships.values()) db.prepare('insert into item_labels values (?,?,?,?,?,?)').run(row.item_id, input.target_id, row.prob, 'user', row.decided, stamp);
      for (const id of input.label_ids) {
        db.prepare("update labels set source='user' where id=?").run(id);
        if (id !== input.target_id) db.prepare('insert into story_aliases values (?,?) on conflict(from_id) do update set to_id=excluded.to_id').run(id, input.target_id);
      }
    }
  }

  function restore(operation, input, before) {
    if(operation==='collection_edit'){
      db.prepare('delete from collection_items where collection_id=?').run(input.id);db.prepare('delete from collections where id=?').run(input.id);
      for(const row of before.collections)db.prepare('insert into collections values (?,?,?,?)').run(row.id,row.name,row.description,row.created);
      for(const row of before.collection_items)db.prepare('insert into collection_items values (?,?)').run(row.collection_id,row.item_id);
    }else if(operation==='edit_label'||operation==='story_edit'){
      for(const id of [input.id,...input.source_id?[input.source_id]:[]])db.prepare('delete from item_labels where label_id=?').run(id);
      if(input.creating)db.prepare('delete from labels where id=?').run(input.id);
      for(const row of before.labels)db.prepare('update labels set name=?,description=?,keywords=?,source=?,created=? where id=?').run(row.name,row.description,row.keywords,row.source,row.created,row.id);
      for(const row of before.item_labels)db.prepare('insert into item_labels values (?,?,?,?,?,?)').run(row.item_id,row.label_id,row.prob,row.source,row.decided,row.updated);
    }else if(operation==='source_control'){
      db.prepare('delete from sources where id=?').run(input.id);
      for(const row of before.sources){const keys=Object.keys(row);db.prepare(`insert into sources(${keys.join(',')}) values(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key]));}
    } else if (operation === 'merge_stories' || operation === 'update_post_labels') {
      if (operation === 'merge_stories') {
        for (const id of input.label_ids) {
          db.prepare('delete from item_labels where label_id=?').run(id);
          db.prepare('delete from story_aliases where from_id=?').run(id);
        }
        for (const row of before.labels) db.prepare('update labels set name=?,description=?,keywords=?,source=?,created=? where id=?').run(row.name, row.description, row.keywords, row.source, row.created, row.id);
        for (const row of before.story_aliases) db.prepare('insert into story_aliases values (?,?)').run(row.from_id, row.to_id);
      } else for (const post of input.post_ids) for (const label of input.label_ids) db.prepare('delete from item_labels where item_id=? and label_id=?').run(post, label);
      for (const row of before.item_labels) db.prepare('insert into item_labels values (?,?,?,?,?,?)').run(row.item_id, row.label_id, row.prob, row.source, row.decided, row.updated);
    } else if (operation === 'mark_posts_reviewed') {
      for (const id of input.post_ids) db.prepare('delete from post_reviews where item_id=?').run(id);
      for (const row of before.post_reviews) db.prepare('insert into post_reviews values (?,?,?)').run(row.item_id, row.reviewed_at, row.actor);
    } else for (const row of before.items) {
      const fields = Object.keys(row).filter(key => key !== 'id');
      db.prepare(`update items set ${fields.map(key => `${key}=?`).join(',')} where id=?`).run(...fields.map(key => row[key]), row.id);
    }
  }

  function preview(operation, raw) {
    return transaction(db, () => {
      const input = normalize(operation, raw), before = snapshot(operation, input);
      // Execute the real validator/mutation in a nested rollback-only savepoint.
      let after;
      db.exec('savepoint agent_dry_run');
      try { mutate(operation, input, Date.now()); after = snapshot(operation, input); }
      finally { db.exec('rollback to agent_dry_run; release agent_dry_run'); }
      const id = randomUUID(), created = Date.now();
      db.prepare('insert into agent_previews values (?,?,?,?,?,?)').run(id, operation, JSON.stringify(input), JSON.stringify(before), created, created + 15 * 60000);
      return { preview_id: id, operation, input, before, after, expires_at: new Date(created + 15 * 60000).toISOString(), business_changes: false, preview_recorded: true,
        ...(operation === 'reclassify_posts' ? { warning: 'Queues existing classifiers and may consume provider budget. Classifier outputs cannot be rolled back using this queue receipt.' } : {}) };
    });
  }

  function apply(id, expectedOperation, expectedAction) {
    return transaction(db, () => {
      const prior = db.prepare('select id,operation,undone,input from agent_receipts where preview_id=?').get(id);
      if(prior&&expectedOperation&&prior.operation!==expectedOperation)throw fail('Preview belongs to a different operation.');
      if(prior && expectedAction && JSON.parse(prior.input).action !== expectedAction)throw fail('Preview belongs to a different source action.');
      if (prior) return { receipt_id: prior.id, operation: prior.operation, replay: true, undone: !!prior.undone };
      const plan = db.prepare('select * from agent_previews where id=?').get(id);
      if (!plan || plan.expires < Date.now()) throw fail('Preview missing or expired.');
      if(expectedOperation&&plan.operation!==expectedOperation)throw fail('Preview belongs to a different operation.');
      if(expectedAction && JSON.parse(plan.input).action !== expectedAction)throw fail('Preview belongs to a different source action.');
      const input = normalize(plan.operation, JSON.parse(plan.input)), before = snapshot(plan.operation, input);
      if (!same(before, JSON.parse(plan.before_json))) throw fail('Affected records changed since preview.');
      const created = Date.now(), receipt = randomUUID();
      mutate(plan.operation, input, created);
      const after = snapshot(plan.operation, input);
      db.prepare('insert into agent_receipts values (?,?,?,?,?,?,?,null)').run(receipt, id, plan.operation, plan.input, JSON.stringify(before), JSON.stringify(after), created);
      let job_id;
      if (plan.operation === 'reclassify_posts') {
        job_id = receipt;
        db.prepare('insert into agent_jobs values (?,?,?,?)').run(job_id, 'reclassify', plan.input, created);
      }
      return { receipt_id: receipt, operation: plan.operation, applied: true, ...(job_id ? { job_id, status: 'queued', manual_decisions_preserved: true } : {}) };
    });
  }

  function undo(id, applyUndo = false) {
    return transaction(db, () => {
      const receipt = db.prepare('select * from agent_receipts where id=?').get(id);
      if (!receipt) throw fail('Receipt not found.');
      if (receipt.operation === 'reclassify_posts') throw fail('Classifier jobs are not reversible through queue receipts. Use explicit reviewed label decisions.');
      if (receipt.undone) return { receipt_id: id, undone: true, replay: true };
      const input = JSON.parse(receipt.input), current = snapshot(receipt.operation, input);
      if (!same(current, JSON.parse(receipt.after_json))) throw fail('Affected records changed after this operation; undo refused.');
      if (!applyUndo) return { preview: true, receipt_id: id, operation: receipt.operation, before: current, after: JSON.parse(receipt.before_json) };
      restore(receipt.operation, input, JSON.parse(receipt.before_json));
      db.prepare('update agent_receipts set undone=? where id=?').run(Date.now(), id);
      return { receipt_id: id, undone: true };
    });
  }

  function history() { return db.prepare('select id,operation,created,undone from agent_receipts order by created desc limit 100').all(); }
  function jobs(provider='rules') {
    return db.prepare('select * from agent_jobs order by created desc limit 100').all().map(job => {
      const input = JSON.parse(job.input), pending = input.post_ids.filter(id => {
        const row = db.prepare('select ai_done,cf_done,cat_done from items where id=?').get(id);
        return row && (provider==='cloudflare'?row.cf_done:provider==='chat'?row.ai_done:row.cat_done)===0;
      }).length;
      return { id: job.id, kind: job.kind, created: job.created, requested: input.post_ids.length, pending, provider, status: pending ? 'queued_or_processing' : 'processed_by_configured_classifier' };
    });
  }
  function collections(){return db.prepare('select * from collections order by name,id').all().map(item=>({...item,post_ids:db.prepare('select item_id from collection_items where collection_id=? order by item_id').all(item.id).map(row=>row.item_id)}));}
  return { preview, apply, undo, history, jobs, collections };
}
