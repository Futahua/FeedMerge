import http from 'node:http';
const upstream = new URL(process.env.FEEDMERGE_UPSTREAM);
const port = Number(process.env.FEEDMERGE_PORT || 4747);
const server=http.createServer((req,res)=>{
 if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)){res.writeHead(403);res.end();return;}
 const proxy=http.request({hostname:upstream.hostname,port:upstream.port,path:req.url,method:req.method,headers:{...req.headers,host:upstream.host}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
 proxy.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'FeedMerge backend is unavailable.'}));});
 proxy.setTimeout(120000,()=>proxy.destroy());req.on('aborted',()=>proxy.destroy());req.pipe(proxy);
});
server.listen(port,'127.0.0.1');

