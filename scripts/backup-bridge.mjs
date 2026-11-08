import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
const bind=process.env.FEEDMERGE_BACKUP_BIND,client=process.env.FEEDMERGE_BACKUP_CLIENT,dbPath=process.env.FEEDMERGE_DB;
if(!bind||!client||!dbPath)throw Error('Explicit private bind, allowed client and database required');
let busy=false;
http.createServer(async(req,res)=>{
 if(req.socket.remoteAddress!==client||req.method!=='GET'||req.url!=='/snapshot'){res.writeHead(403);res.end();return;}
 if(busy){res.writeHead(503);res.end();return;}busy=true;
 const file=path.join(path.dirname(dbPath),'standby-snapshot.sqlite');
 try{const db=new DatabaseSync(dbPath,{readOnly:true});try{await backup(db,file);}finally{db.close();}
 res.writeHead(200,{'content-type':'application/octet-stream','content-length':fs.statSync(file).size});
 await new Promise((resolve,reject)=>{const stream=fs.createReadStream(file);stream.on('error',reject);res.on('finish',resolve);res.on('close',()=>{stream.destroy();resolve();});stream.pipe(res);});
 }catch{if(!res.headersSent)res.writeHead(500);res.end();}finally{busy=false;}
}).listen(Number(process.env.FEEDMERGE_BACKUP_PORT||4788),bind);
