import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const listen=async s=>{s.listen(0,'127.0.0.1');await once(s,'listening');return s.address().port;};
test('private relay preserves writes and query strings, refuses foreign hosts and fails closed offline',async()=>{
 const upstream=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;res.setHeader('content-type','application/json');res.end(JSON.stringify({method:req.method,url:req.url,body,header:req.headers['x-feedmerge']}));});
 const remote=await listen(upstream),reserve=http.createServer(),port=await listen(reserve);await new Promise(r=>reserve.close(r));
 const child=spawn(process.execPath,['scripts/relay.mjs'],{env:{...process.env,FEEDMERGE_PORT:String(port),FEEDMERGE_UPSTREAM:`http://127.0.0.1:${remote}`},stdio:'ignore',windowsHide:true});
 try{
  let ready=false;for(let i=0;i<60;i++){try{await fetch(`http://127.0.0.1:${port}`);ready=true;break;}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready);
  const response=await fetch(`http://127.0.0.1:${port}/ingest?q=abc`,{method:'POST',headers:{'x-feedmerge':'1'},body:'capture'});
  assert.deepEqual(await response.json(),{method:'POST',url:'/ingest?q=abc',body:'capture',header:'1'});
  const bad=await new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port,headers:{host:'foreign.test'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(bad,403);
  await new Promise(r=>upstream.close(r));assert.equal((await fetch(`http://127.0.0.1:${port}`)).status,503);
 }finally{child.kill();await once(child,'exit');upstream.close();}
});
