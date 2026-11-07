import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

test('actual isolated API enforces rename preconditions, agent provenance and management undo', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'feedmerge-api-'));
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0,'127.0.0.1',resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const config = path.join(dir, 'config.json'); await writeFile(config, JSON.stringify({ ai: { enabled: false } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env: { ...process.env, FEEDMERGE_PORT: String(port), FEEDMERGE_DATA_DIR: dir, FEEDMERGE_CONFIG: config }, stdio: ['ignore','pipe','pipe'], windowsHide: true });
  let errors = ''; child.stderr.on('data', d => errors += d);
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET', headers: { 'x-feedmerge': '1','content-type':'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json() };
  };
  try {
    let ready = false;
    for (let i=0;i<80;i++) { try { if ((await api('/api/categories')).status===200) {ready=true;break;} } catch {} await new Promise(resolve=>setTimeout(resolve,50)); }
    assert(ready, errors);
    await api('/ingest', { platform:'web',kind:'links',url:'https://example.test',payload:[{url:'https://example.test/article',title:'An isolated original article long enough for testing'}] });
    const post = (await api('/api/items?ads=1')).value[0]; assert(post);
    await api(`/api/items/${encodeURIComponent(post.id)}/label`, { layer:'topic',name:'Isolated agent category',source:'agent',prob:.4 });
    const labels = (await api('/api/categories')).value.layers.flatMap(x=>x.labels);
    const label = labels.find(x=>x.name==='Isolated agent category'); assert.equal(label.source,'agent');
    assert.equal((await api('/api/labels',{id:label.id,name:'Wrong edit',expectedName:'stale'})).status,409);
    const p = (await api('/api/agent/preview',{operation:'save_posts',input:{post_ids:[post.id],saved:true}})).value;
    assert.equal((await api(`/api/items/${encodeURIComponent(post.id)}`)).value.saved,false);
    const r = (await api('/api/agent/apply',{preview_id:p.preview_id})).value; assert(r.receipt_id);
    assert.equal((await api(`/api/items/${encodeURIComponent(post.id)}`)).value.saved,true);
    assert.equal((await api('/api/agent/undo',{receipt_id:r.receipt_id,apply:true})).status,200);
    assert.equal((await api(`/api/items/${encodeURIComponent(post.id)}`)).value.saved,false);
    assert.equal((await api('/api/ingestion-status')).status,200);
    await api('/ingest', {platform:'web',kind:'links',url:'https://example.test',payload:Array.from({length:12},(_,i)=>({url:`https://example.test/shuffle-${i}`,title:`Shuffle fixture article number ${i} with enough text`}))});
    const ids=async(seed,offset=0,limit=200)=>(await api(`/api/items?ads=1&sort=shuffle&seed=${seed}&offset=${offset}&limit=${limit}`)).value.map(x=>x.id);
    const shuffled=await ids(1234567);
    assert(shuffled.length>10);
    assert.deepEqual(await ids(1234567),shuffled);
    assert.deepEqual([...(await ids(1234567,0,5)),...(await ids(1234567,5,200))],shuffled);
    assert.notDeepEqual(await ids(7654321),shuffled);

    // Two accounts (two Chrome profiles) shown the same post: one merged post, both accounts known.
    const shared = { platform:'web',kind:'links',url:'https://example.test',payload:[{url:'https://example.test/shared-post',title:'A post both accounts were shown, long enough'}] };
    await api('/ingest', { ...shared, profile:'aaaaaaaaaaaaaaaa', account:'111' });
    await api('/ingest', { ...shared, profile:'bbbbbbbbbbbbbbbb', account:'222' });
    await api('/ingest', { ...shared, profile:'not a profile id', account:'333' });
    const merged = (await api('/api/items?ads=1&limit=200')).value.filter(x=>x.url==='https://example.test/shared-post');
    assert.equal(merged.length,1);
    const f = (await api('/api/facets')).value;
    assert.equal(f.profiles,2);
    assert.deepEqual(f.accounts.map(a=>[a.platform,a.n]),[['web',2]]);
    // A browser-read source: only same-site headline links from the extension are kept.
    const { DatabaseSync } = await import('node:sqlite');
    const side = new DatabaseSync(path.join(dir, 'feed.db'));
    const sid = side.prepare("insert into sources(kind, name, url, interval_min, created) values ('rendered', 'App site (browser)', 'https://1.1.1.1/', 60, 1)").run().lastInsertRowid;
    side.close();
    assert.equal((await api('/api/rendered-sources')).value.length, 1);
    const got = (await api(`/api/rendered-sources/${sid}`, { links: [
      { url: 'https://1.1.1.1/2026/11/7/first-story', title: 'A first story drawn by the app in the browser' },
      { url: 'https://elsewhere.test/ad', title: 'An outside link that must not be kept at all' },
    ] })).value;
    assert.equal(got.parsed, 1);
    assert.equal((await api('/api/items?ads=1&limit=200')).value.filter(x => x.context === 'App site (browser)').length, 1);
    const inspected=(await api(`/api/sources/${sid}/inspect`)).value;
    assert.equal(inspected.browser_report.extracted_count,1);
    const tested=(await api(`/api/sources/${sid}/test-rules`,{rules:{minTitleLength:5,includePaths:['/news/']},html:'<a href="/news/one">Short news</a><a href="/login">Login form</a>'})).value;
    assert.equal(tested.extracted_count,1);
    const plan=(await api('/api/agent/preview',{operation:'source_control',input:{action:'configure',id:Number(sid),mode:'page',rules:{minTitleLength:5,includePaths:['/news/']}}})).value;
    assert.equal((await api(`/api/sources/${sid}/inspect`)).value.source.mode,'rendered');
    assert.equal((await api('/api/agent/apply',{operation:'source_control',preview_id:plan.preview_id,expected_action:'remove'})).status,409);
    const applied=(await api('/api/agent/apply',{operation:'source_control',preview_id:plan.preview_id,expected_action:'configure'})).value;
    assert.equal((await api(`/api/sources/${sid}/inspect`)).value.source.rules.minTitleLength,5);
    await api('/api/agent/undo',{receipt_id:applied.receipt_id,apply:true});
    assert.equal((await api(`/api/sources/${sid}/inspect`)).value.source.mode,'rendered');
    const capture=(await api('/api/agent/preview',{operation:'source_control',input:{action:'capture',id:Number(sid)}})).value;
    await api('/api/agent/apply',{operation:'source_control',preview_id:capture.preview_id,expected_action:'capture'});
    assert.equal((await api(`/api/sources/${sid}/inspect`)).value.browser_state,'queued_waiting_for_permitted_browser');
    assert.equal((await api(`/api/rendered-sources/${sid}`,{links:[],final_url:'https://elsewhere.test/private'})).status,409);
    const probe=new DatabaseSync(path.join(dir,'feed.db'));probe.prepare("insert into sources(kind,name,url,interval_min,created) values ('rendered','private','http://127.0.0.1:12345/',60,1)").run();probe.close();
    assert.equal((await api('/api/rendered-sources')).value.length,1); // private targets never enter the browser queue
    const controls=(await api('/api/backend/controls')).value;
    assert(controls.controls.length>=50);assert(!JSON.stringify(controls).includes('apiToken'));
    const settings=(await api('/api/agent/preview',{operation:'backend_settings',input:{changes:{'viewer.platforms.pinterest.keepPercent':25,'capture.platforms.pinterest.hours':18,'capture.platforms.pinterest.scrolls':3}}})).value;
    assert.equal((await api('/api/viewer-policy')).value.platforms,undefined);
    const settingReceipt=(await api('/api/agent/apply',{operation:'backend_settings',preview_id:settings.preview_id})).value;
    assert.equal((await api('/api/viewer-policy')).value.platforms.pinterest.keepPercent,25);
    assert.equal((await api('/api/capture-policy')).value.platforms.pinterest.scrolls,3);
    await api('/api/agent/undo',{receipt_id:settingReceipt.receipt_id,apply:true});
    assert.equal((await api('/api/viewer-policy')).value.platforms,undefined);
    const work=(await api('/api/agent/preview',{operation:'backend_job',input:{action:'reparse'}})).value;
    const queued=(await api('/api/agent/apply',{operation:'backend_job',preview_id:work.preview_id,expected_action:'reparse'})).value;
    let status;
    for(let i=0;i<50;i++){status=(await api('/api/ingestion-status')).value.jobs.find(j=>j.id===queued.job_id);if(['completed','failed'].includes(status?.status))break;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal(status?.status,'completed',status?.error);assert.equal(status.result.backup_created,true);
    assert.equal((await api('/api/agent/undo',{receipt_id:queued.receipt_id,apply:true})).status,409);


  } finally {
    child.kill(); await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
    await rm(dir,{recursive:true,force:true});
  }
});
