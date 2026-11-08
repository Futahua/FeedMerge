import http from 'node:http';
const upstream = new URL(process.env.FEEDMERGE_UPSTREAM);
const port = Number(process.env.FEEDMERGE_PORT || 4747);
const server=http.createServer((req,res)=>{
 if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)){res.writeHead(403);res.end();return;}
 if(process.env.FEEDMERGE_CAPTURE_ENABLED==='0'){
  const pathname=new URL(req.url,'http://localhost').pathname;
  const json=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  if(pathname==='/api/capture-policy')return json(200,{enabled:false,collectorEnabled:false,platforms:Object.fromEntries(['x','youtube','tiktok','facebook','instagram','pinterest','threads','bluesky','reddit'].map(p=>[p,{on:false}]))});
  if(pathname==='/api/rendered-sources')return json(200,[]);
  if(pathname==='/ingest'||/^\/api\/rendered-sources\/[^/]+$/.test(pathname))return json(403,{error:'Capture is disabled on this device; use the designated collector.'});
 }
 const proxy=http.request({hostname:upstream.hostname,port:upstream.port,path:req.url,method:req.method,headers:{...req.headers,host:upstream.host}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
 proxy.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'FeedMerge backend is unavailable.'}));});
 proxy.setTimeout(120000,()=>proxy.destroy());req.on('aborted',()=>proxy.destroy());req.pipe(proxy);
});
server.listen(port,'127.0.0.1');

