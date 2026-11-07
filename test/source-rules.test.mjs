import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import {normalizeRules,filterSourceLinks} from '../source-rules.mjs';
import {initSources,extractLinks,inspectSource} from '../sources.mjs';
import {createManagement} from '../management.mjs';

test('static extraction tests short titles and path rules without script links or offsite ingestion',async()=>{
 const html='<script><a href="/news/fake">Fake script headline that should not be captured</a></script><a href="/news/one">Short title</a><a href="/login">Sign in now</a><a href="https://other.test/news/a">Outside story</a><a href="javascript:alert(1)">Bad story</a><a href="/news/one#part">Short title</a>';
 const rules={minTitleLength:5,includePaths:['/news/'],excludePaths:['/login']};
 assert.deepEqual(extractLinks(html,'https://site.test',rules),[{url:'https://site.test/news/one',title:'Short title'}]);
 const result=await inspectSource({url:'https://site.test'},rules,html);
 assert.equal(result.input,'supplied_html');assert.equal(result.extracted_count,1);assert(!('html' in result));
 const browser=await inspectSource({url:'https://site.test'},{linkSelector:'main .story a[href]'},html);
 assert.equal(browser.extracted_count,0);assert.match(browser.warning,/not evaluated/);
 assert.equal(filterSourceLinks([{url:'https://user:password@site.test/news/one',title:'Short title'}],'https://site.test',rules).length,0);
});

test('rules reject code, expensive selectors, unknown keys and invalid limits',()=>{
 for(const value of [{script:'alert(1)'},{linkSelector:'a:has(*)'},{linkSelector:'a[href="secret"]'},{minTitleLength:2},{minTitleLength:80,maxTitleLength:20},{includePaths:['https://x.test']},{excludePaths:Array(21).fill('/x')}])assert.throws(()=>normalizeRules(value));
 assert.equal(normalizeRules({linkSelector:'main > .story a[href]'}).minTitleLength,25);
});

test('source changes are previewed, reversible, refuse stale results and bind action type',()=>{
 const db=new DatabaseSync(':memory:');initSources(db);const owner=createManagement(db);
 db.prepare("insert into sources(id,kind,name,url,created,last_fetch) values (1,'page','Odd site','https://site.test',1,123)").run();
 const p=owner.preview('source_control',{action:'configure',id:1,mode:'rendered',rules:{minTitleLength:8,linkSelector:'.story a[href]'}});
 assert.equal(db.prepare('select kind from sources').get().kind,'page');
 assert.throws(()=>owner.apply(p.preview_id,'source_control','remove'),/different source action/);
 const result=owner.apply(p.preview_id,'source_control','configure');
 assert.equal(db.prepare('select kind from sources').get().kind,'rendered');
 owner.undo(result.receipt_id,true);assert.equal(db.prepare('select kind from sources').get().kind,'page');
 assert.throws(()=>owner.preview('source_control',{action:'capture',id:1}),/enabled rendered/);
 const stale=owner.preview('source_control',{action:'configure',id:1,mode:'page',rules:{minTitleLength:10}});
 db.exec('update sources set last_fetch=456');assert.throws(()=>owner.apply(stale.preview_id),/changed since preview/);
 db.close();
});

test('browser extractor reads only selected anchors and refuses an origin change',()=>{
 const source=fs.readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('function collectHeadlines('),source.indexOf('async function renderedDue('));
 const location={origin:'https://site.test',host:'site.test',href:'https://site.test/'};
 const ctx=vm.createContext({URL,location,document:{title:'Odd site',querySelectorAll:selector=>{
   assert.equal(selector,'.story a[href]');return [{tagName:'A',href:'https://site.test/news/one',innerText:'A short story'},{tagName:'A',href:'https://other.test/private',innerText:'Outside story'},{tagName:'INPUT',value:'password'}];
 }}});vm.runInContext(fn,ctx);
 const result=ctx.collectHeadlines({linkSelector:'.story a[href]',minTitleLength:5},'https://site.test');
 assert.equal(result.links.length,1);assert.equal(result.candidate_count,3);assert(!JSON.stringify(result).includes('password'));
 assert.throws(()=>ctx.collectHeadlines({},'https://different.test'),/changed origin/);
});
