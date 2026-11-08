import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('async function createRefreshTab('),source.indexOf('async function finishOpen('));
test('refresh tabs never create, restore, focus or activate a Chrome window/tab',async()=>{
 const calls=[];
 const ctx=vm.createContext({chrome:{windows:{getAll:async()=>[{id:1,state:'normal',focused:false},{id:2,state:'normal',focused:true}]},tabs:{create:async options=>{calls.push(['create',options]);return {id:42}},update:async(id,options)=>{calls.push(['update',id,options]);}}}});
 vm.runInContext(fn,ctx);
 const tab=await ctx.createRefreshTab('https://www.pinterest.com/');
 assert.equal(tab.id,42);assert.equal(calls[0][1].windowId,2);assert.equal(calls[0][1].active,false);
 assert.equal(calls[1][2].active,false);assert.equal(calls[1][2].muted,true);assert.equal(calls[1][2].autoDiscardable,false);
 assert.equal(calls[1][2].url,'https://www.pinterest.com/');
 assert(!source.includes('chrome.windows.create('));
});
test('no regular window means defer, never launch a popup or use incognito',async()=>{
 for(const windows of [[],[{id:5,incognito:true,focused:true}]]){
   const ctx=vm.createContext({chrome:{windows:{getAll:async()=>windows},tabs:{create:async()=>{throw Error('Should not create a tab')}}}});
   vm.runInContext(fn,ctx);assert.equal(await ctx.createRefreshTab('https://site.test'),null);
 }
});
test('both social and browser-only collection use the same quiet helper',()=>{
 assert(source.includes('await createRefreshTab(TARGETS[platform].url)'));
 assert(source.includes('await createRefreshTab(src.url)'));
 // Pinterest pacing and dwell/autoscroll timings are preserved.
 assert(source.includes("pinterest: { url: 'https://www.pinterest.com/', hours: 18 }"));
 assert(source.includes("platform === 'pinterest' ? 3 : 8"));
 assert(source.includes('const DWELL_MS = 40_000'));
});
