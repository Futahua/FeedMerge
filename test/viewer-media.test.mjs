import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const context=vm.createContext({URL,window:{addEventListener(){}},IntersectionObserver:class{observe(){}},matchMedia:()=>({matches:true})});
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

test('Reddit gallery counts assets once and prefers originals over blurred previews',()=>{
  const media=[{type:'image',url:'https://preview.redd.it/abc123.png?blur=32'},{type:'image',url:'https://preview.redd.it/post-title-v0-abc123.png?width=640'},{type:'image',url:'https://i.redd.it/abc123.png'},{type:'image',url:'https://preview.redd.it/post-v0-def456.jpeg?width=640'},{type:'image',url:'https://i.redd.it/def456.jpeg'}];
  const result=context.window.Native.redditMedia(media);
  assert.equal(result.length,2);assert.equal(result[0].url,'https://i.redd.it/abc123.png');assert.equal(result[1].url,'https://i.redd.it/def456.jpeg');
  assert.equal(media.length,5);
});
test('social cards do not offer noninteractive official embeds',()=>{
  for(const platform of ['x','instagram','threads','bluesky','reddit']){
    const html=render({id:'fixture',nativeId:'fixture',platform,author:'author',authorName:'author',text:'Text',media:[],metrics:{},flags:{}},'');
    assert(!html.includes('data-embed'),platform);
  }
  assert(render({platform:'youtube',nativeId:'fixture',media:[],metrics:{},flags:{}},'').includes('data-play'));
});

test('Reddit galleries have desktop arrows that navigate exactly one image',()=>{
  const item={platform:'reddit',media:[{url:'https://i.redd.it/a.png',type:'image'},{url:'https://i.redd.it/b.png',type:'image'}],metrics:{},flags:{}};
  const html=render(item,'');assert(html.includes('aria-label="Next image"'));assert(html.includes('aria-label="Previous image" disabled'));
  let destination;
  const track={clientWidth:300,scrollLeft:0,children:[{},{}],scrollTo(opts){destination=opts.left}};
  const arrow={dataset:{galleryStep:'1'},closest:()=>({querySelector:()=>track})};
  const target={closest:selector=>selector==='[data-gallery-step]'?arrow:null};
  assert.equal(context.window.Native.handleClick({target},item,{}),true);assert.equal(destination,300);
  track.scrollLeft=300;arrow.dataset.galleryStep='-1';context.window.Native.handleClick({target},item,{});assert.equal(destination,0);
  item.media.pop();assert(!render(item,'').includes('data-gallery-step'));
});
