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

  } finally {
    child.kill(); await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
    await rm(dir,{recursive:true,force:true});
  }
});
