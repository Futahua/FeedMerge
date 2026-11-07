// Integrate a public publisher catalog using the normal source owner and receipts.
// Resume safely: completed publishers are checkpointed; failed entries can be retried.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {resolveSource,initSources,startPoller} from '../sources.mjs';
import {createManagement} from '../management.mjs';
const API=process.env.FEEDMERGE_URL||'http://127.0.0.1:4747';
const catalog=JSON.parse(fs.readFileSync(process.argv[2]||'catalogs/world-sources.json','utf8')).sources;
const folder='data/imports';fs.mkdirSync(folder,{recursive:true});
const file=path.join(folder,'world-sources-20261108.json');
const results=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).results:[];
const retry=process.argv.includes('--retry');
const aliases={'feeds.bbci.co.uk':'bbc.com','rss.dw.com':'dw.com','feeds.arstechnica.com':'arstechnica.com','rss.arxiv.org':'arxiv.org'};
const key=url=>{const host=new URL(url).hostname.replace(/^www\./,'');return aliases[host]||host;};
const folded=s=>String(s).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
async function api(route,body){
 const response=await fetch(API+route,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-feedmerge':'1','x-feedmerge-agent':'1'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(35000)});
 const value=await response.json();if(!response.ok)throw Error(value.error||`HTTP ${response.status}`);return value;
}
let existing=await api('/api/sources');
// The same source/receipt owner may be used by a local maintenance CLI while the
// HTTP server remains running. No second scheduler, store or ingestion path.
const db=new DatabaseSync(process.env.FEEDMERGE_DB||'data/feed.db');
db.exec('pragma busy_timeout=5000');initSources(db);
const owner=createManagement(db);
const poller=startPoller(db,async cap=>{for(let i=0;;i++){try{return await api('/ingest',cap);}catch(e){if(i>=4||!/database is locked/.test(e.message))throw e;await new Promise(r=>setTimeout(r,150*(i+1)));}}},()=>{},()=>({}),{schedule:false});
async function previewAdd(url,name,browserFallback){
 const resolved=await resolveSource(url,{browserFallback});resolved.name=name;
 for(let attempt=0;;attempt++){try{return owner.preview('source_control',{action:'add',resolved,interval:360});}catch(e){if(attempt>=4||!/database is locked/.test(e.message))throw e;await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));}} 
}
function checkpoint(){fs.writeFileSync(file,JSON.stringify({updated_at:new Date().toISOString(),total:catalog.length,results},null,2)+'\n');}
function record(entry,result){const at=results.findIndex(x=>x.key===entry.key);const row={key:entry.key,name:entry.name,sections:entry.sections,checked_at:new Date().toISOString(),...result};if(at<0)results.push(row);else results[at]=row;checkpoint();}
function counts(){return results.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{});}
async function integrate(entry){
 const prior=results.find(x=>x.key===entry.key);
 if(entry.excluded){
   const src=existing.find(s=>key(s.url)===entry.key||s.name===entry.name);
   let receipt;
   if(src){receipt=owner.apply(owner.preview('source_control',{action:'remove',id:src.id}).preview_id,'source_control','remove');existing=existing.filter(s=>s.id!==src.id);}
   record(entry,{status:'excluded_by_user',reason:entry.excluded_reason,...(receipt?{removed_source_id:src.id,receipt_id:receipt.receipt_id}:{})});return;
 }

 if(prior&&(!retry||!['failed','configured_unverified'].includes(prior.status)))return;
 if(entry.note){record(entry,{status:entry.key==='reddit.com'?'native_capture':entry.scope_kind?'needs_specific_scope':'needs_specific_instance',reason:entry.note});return;}
 const found=existing.find(s=>key(s.url)===entry.key||entry.aliases.some(n=>folded(n).length>=6&&folded(s.name).includes(folded(n))));
 if(found){
   if(prior?.status==='configured_unverified'&&found.kind!=='rendered'){
     await poller.pollNow(found.id);const checked=db.prepare('select * from sources where id=?').get(found.id);
     record(entry,{status:checked.last_count>0&&!checked.last_error?'verified':checked.kind==='feed'&&checked.last_count===0&&!checked.last_error?'empty_feed':'configured_unverified',source_id:checked.id,mode:checked.kind,url:checked.url,articles:checked.last_count,last_error:checked.last_error});return;
   }
   record(entry,{status:found.kind==='rendered'&&!found.last_ok?'browser_pending':'existing',source_id:found.id,mode:found.kind,url:found.url,articles:found.last_count,last_error:found.last_error});return;
 }
 const errors=[];let selected;
 const candidates=[...entry.preferred.map(url=>({url,preferred:true})),...entry.urls.map(url=>({url,preferred:false}))];
 for(const candidate of candidates){
   try{
     const plan=await previewAdd(candidate.url,entry.name,!candidate.preferred);
     if(candidate.preferred&&plan.input.resolved.kind!=='feed'){errors.push('Suggested RSS address was not a feed: '+candidate.url);continue;}
     selected={plan,candidate};break;
   }catch(e){errors.push(candidate.url+': '+e.message);}
 }
 if(!selected){record(entry,{status:'failed',errors});return;}
 let plan=selected.plan,receipt;
 for(let attempt=0;attempt<3;attempt++){
   try{receipt=owner.apply(plan.preview_id,'source_control','add');break;}
   catch(e){
     if(attempt===2)throw e;
     existing=await api('/api/sources');
     const duplicate=existing.find(s=>s.url===plan.input.resolved.url);
     if(duplicate){record(entry,{status:'existing',source_id:duplicate.id,mode:duplicate.kind,url:duplicate.url,articles:duplicate.last_count});return;}
     plan=await previewAdd(plan.input.resolved.url,entry.name,true);
   }
 }
 const source={id:plan.input.id,name:entry.name,url:plan.input.resolved.url,kind:plan.input.resolved.kind};existing.push(source);
 if(source.kind==='rendered'){record(entry,{status:'browser_pending',source_id:source.id,mode:source.kind,url:source.url,receipt_id:receipt.receipt_id,reason:'Needs a running extension with host permission; no browser capture verified.'});return;}
 let refreshError;
 try{await poller.pollNow(source.id);}catch(e){refreshError=e.message;}
 const latest=(await api('/api/sources')).find(s=>s.id===source.id);
 record(entry,{status:latest?.last_count>0&&!latest?.last_error?'verified':latest?.kind==='feed'&&latest?.last_count===0&&!latest?.last_error?'empty_feed':'configured_unverified',source_id:source.id,mode:source.kind,url:source.url,articles:latest?.last_count||0,last_error:latest?.last_error||refreshError||null,receipt_id:receipt.receipt_id});
}
let next=0;
const started=Date.now();
await Promise.all(Array.from({length:6},async()=>{
 while(next<catalog.length){const entry=catalog[next++];try{await integrate(entry);}catch(e){record(entry,{status:'failed',errors:[e.message]});}
 console.log(JSON.stringify({done:results.length,total:catalog.length,publisher:entry.name,counts:counts(),seconds:Math.round((Date.now()-started)/1000)}));}
}));
const escape=s=>String(s??'').replace(/\|/g,'\\|').replace(/[\r\n]/g,' ');
const rows=results.map(r=>`| ${escape(r.name)} | ${escape(r.status)} | ${r.source_id||'—'} | ${escape(r.mode||'')} | ${r.articles??'—'} | ${escape(r.last_error||r.reason||r.errors?.join('; ')||'')} |`);
fs.writeFileSync(path.join(folder,'world-sources-report.md'),`# Source catalog integration\n\nUpdated ${new Date().toISOString()}.\n\nA verified source returned parsed posts. Browser-pending is not a successful capture. Existing sources were retained rather than duplicated. Polling interval for new sources: six hours.\n\n${JSON.stringify(counts())}\n\n| Publisher | Status | Source ID | Mode | Parsed posts | Note |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`);
console.log(JSON.stringify({finished:true,counts:counts(),report:path.join(folder,'world-sources-report.md')}));
db.close();
