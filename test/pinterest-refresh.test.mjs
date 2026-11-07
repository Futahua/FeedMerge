import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('Pinterest refresh migrates existing profiles once to twelve hours without speeding up slower schedules',async()=>{
 const source=fs.readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
 const targets=source.slice(source.indexOf('const TARGETS ='),source.indexOf('const DWELL_MS'));
 const fn=source.slice(source.indexOf('async function refreshState()'),source.indexOf('const saveRefresh'));
 for(const hours of [6,24]){
  let saved={platforms:{pinterest:{on:true,hours}},next:{pinterest:1}};
  const ctx=vm.createContext({Date,Math,chrome:{storage:{local:{get:async()=>({refresh:saved}),set:async({refresh})=>{saved=refresh}}}}});
  vm.runInContext(targets+fn,ctx);
  const first=await ctx.refreshState();assert.equal(first.platforms.pinterest.hours,Math.max(12,hours));assert(first.next.pinterest>=Date.now()+Math.max(12,hours)*3600e3-1000);
  const due=first.next.pinterest;await ctx.refreshState();assert.equal(saved.next.pinterest,due);
 }
});
