import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {gzipSync,brotliCompressSync,deflateSync} from 'node:zlib';
import { publicAddress, checkedDestination, fetchSource } from '../source-fetch.mjs';

test('blocks private, reserved, mapped and mixed DNS answers', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '100.79.172.3', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(publicAddress(ip), false, ip);
  assert(publicAddress('8.8.8.8')); assert(publicAddress('2606:4700:4700::1111'));
  assert(publicAddress('192.0.66.176')); assert(publicAddress('192.0.78.24')); // public publisher hosting, not 192.0.0.0/24
  for(const ip of ['192.0.0.1','192.0.2.1','192.88.99.1'])assert.equal(publicAddress(ip),false);
  await assert.rejects(checkedDestination('https://example.test', { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /not a public/);
  await assert.rejects(checkedDestination('http://2130706433'), /not a public/);
  await assert.rejects(checkedDestination('http://user:pass@example.test'), /credentials/);
});

test('unresponsive DNS is bounded before any connection is attempted',async()=>{
  const keepAlive=setTimeout(()=>{},500);
  try{await assert.rejects(fetchSource('https://unresolved.example',{}, {timeout:20,resolve:()=>new Promise(()=>{})}),/timeout/i);}
  finally{clearTimeout(keepAlive);}
});

test('trusted RSSHub allowance cannot redirect to another private service; response bounded', async () => {
  const target = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/secret' }); res.end(); }
    else res.end('x'.repeat(200));
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${target.address().port}`;
  try {
    await assert.rejects(fetchSource(origin + '/redirect', {}, { trustedOrigin: origin }), /not a public/);
    await assert.rejects(fetchSource(origin, {}, { trustedOrigin: origin, maxBytes: 100 }), /size limit/);
    assert.equal((await fetchSource(origin, {}, { trustedOrigin: origin })).res.status, 200);
  } finally { await new Promise(resolve => target.close(resolve)); }
});

test('compressed publisher pages are decoded and decoded size remains bounded',async()=>{
 const html='<html><a href="/story">An actual publisher headline</a></html>';
 const encoders={gzip:gzipSync,br:brotliCompressSync,deflate:deflateSync};
 const server=http.createServer((req,res)=>{const encoding=req.url.slice(1);res.setHeader('content-encoding',encoding);res.end(encoders[encoding](Buffer.from(html)));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 try{for(const encoding of Object.keys(encoders)){assert.equal((await fetchSource(origin+'/'+encoding,{}, {trustedOrigin:origin})).text,html);await assert.rejects(fetchSource(origin+'/'+encoding,{}, {trustedOrigin:origin,maxBytes:20}),/size limit/);}}
 finally{await new Promise(resolve=>server.close(resolve));}
});
