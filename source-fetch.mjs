// Source fetching owns outbound access, including redirects and later poll cycles.
// Connect to a checked DNS answer, retaining the original Host/TLS server name.
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';

export function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
      a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    const parts = address.toLowerCase().split(':');
    const first = parseInt(parts[0], 16), second = parseInt(parts[1] || '0', 16);
    // Only global unicast; reject mapped/translation/tunnel/documentation ranges.
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}

export async function checkedDestination(input, { trustedOrigin, resolve = lookup, signal } = {}) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Source requires HTTP(S) without embedded credentials.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  signal?.throwIfAborted();
  let abort;
  const pending = isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : resolve(hostname, { all: true, verbatim: true });
  const answers = await (signal ? Promise.race([pending,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]).finally(()=>signal.removeEventListener('abort',abort)) : pending);
  const trusted = trustedOrigin && url.origin === new URL(trustedOrigin).origin;
  if (!answers.length || !trusted && answers.some(x => !publicAddress(x.address))) throw new Error('Source destination is not a public network address.');
  return { url, answers };
}

export async function fetchSource(input, headers = {}, { trustedOrigin, resolve = lookup, timeout = 30000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const signal = AbortSignal.timeout(timeout);
  let current = new URL(input);
  for (let hops = 0; hops <= 5; hops++) {
    const { url, answers } = await checkedDestination(current, { trustedOrigin, resolve, signal });
    const result = await new Promise((resolveResponse, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET', headers, signal, agent: false,
        lookup: (_host, options, done) => options.all ? done(null, answers) : done(null, answers[0].address, answers[0].family),
      }, response => {
        const status = response.statusCode, location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume(); resolveResponse({ redirect: new URL(location, url) }); return;
        }
        const encoding=String(response.headers['content-encoding']||'identity').toLowerCase().trim();
        const decoder=encoding==='gzip'||encoding==='x-gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null;
        if(!decoder&&encoding!=='identity'){response.destroy();reject(new Error('Unsupported source content encoding.'));return;}
        const stream=decoder?response.pipe(decoder):response;
        const chunks = []; let size = 0, wireSize=0;
        if(decoder)response.on('data',chunk=>{wireSize+=chunk.length;if(wireSize>maxBytes)response.destroy(new Error('Source response exceeds size limit.'));});
        stream.on('data', chunk => { size += chunk.length; if (size > maxBytes) { const error=new Error('Source decoded response exceeds size limit.');stream.destroy(error);response.destroy(error); } else chunks.push(chunk); });
        response.on('error', reject);
        if(decoder)decoder.on('error',error=>{response.destroy();reject(error);});
        stream.on('end', () => resolveResponse({ res: { status, ok: status >= 200 && status < 300, url: url.href,
          headers: new Headers(Object.entries(response.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]])) }, text: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject); request.end();
    });
    if (!result.redirect) return { ...result, type: result.res.headers.get('content-type') || '' };
    if (result.redirect.origin !== current.origin) {
      // Never forward conditional/private headers to another origin.
      headers = Object.fromEntries(Object.entries(headers).filter(([key]) => ['user-agent', 'accept'].includes(key.toLowerCase())));
    }
    current = result.redirect;
  }
  throw new Error('Too many source redirects.');
}
