import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const context=vm.createContext({window:{addEventListener(){}},IntersectionObserver:class{observe(){}},matchMedia:()=>({matches:true})});
vm.runInContext(fs.readFileSync(new URL('../viewer/native.js',import.meta.url),'utf8'),context);
const {frameAspect,render}=context.window.Native;
test('media frames preserve readable wide strips and bound ordinary preview cropping',()=>{
  assert.equal(frameAspect(2400,300),8);
  for(const [w,h]of [[1200,900],[400,1000],[2400,1000],[900,1200]]){
    const target=frameAspect(w,h),source=w/h;assert(Math.min(target/source,source/target)>=.75-1e-9);
  }
  assert.equal(frameAspect(0,0),4/3);
});
test('unknown image dimensions use a measurable frame, including quoted media',()=>{
  const item={id:'x:fixture',platform:'x',author:'author',text:'Text',media:[{type:'image',url:'https://example.test/image'}],metrics:{},flags:{quote:{author:'quote',media:[{type:'image',url:'https://example.test/quote'}]}}};
  const html=render(item,'');assert.equal((html.match(/data-media-frame/g)||[]).length,2);
});

test('automatic widening stays within 640 pixels and respects single-column zoom',()=>{
  const app=fs.readFileSync(new URL('../viewer/app.js',import.meta.url),'utf8');
  const fn=app.slice(app.indexOf('function chooseSpan('),app.indexOf('function fitRows('));
  const ctx=vm.createContext({GAP:14,TARGET:1.25,letterbox:()=>0});
  vm.runInContext(fn,ctx);
  for(const base of [240,310,440,700]){
    const style={gridColumnEnd:'span 1'};
    const el={style,get offsetWidth(){return base*Number(style.gridColumnEnd.split(' ')[1])+14*(Number(style.gridColumnEnd.split(' ')[1])-1)},get offsetHeight(){return 2400}};
    ctx.chooseSpan(el,6);
    assert(el.offsetWidth<=Math.max(640,base));
    if(base===700)assert.equal(style.gridColumnEnd,'span 1');
  }
});
