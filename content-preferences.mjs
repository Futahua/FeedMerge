// User exclusions: literal topics, source names and whole words/phrases, never code.
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function compileExclusions(policy={}) {
 const topics=new Set((policy.blockedTopics||[]).map(s=>s.toLowerCase()));
 const sources=new Set((policy.blockedSourceNames||[]).map(s=>s.toLowerCase()));
 const terms=(policy.blockedTerms||[]).map(s=>new RegExp('(?:^|[^\\p{L}\\p{N}_])'+escape(s)+'(?=$|[^\\p{L}\\p{N}_])','iu'));
 return (item,labels=[])=>sources.has(String(item.context||'').toLowerCase())||labels.some(s=>topics.has(String(s).toLowerCase()))||terms.some(re=>re.test(`${item.title||''}\n${item.text||''}`));
}
export function initContentPreferences(db) {
 db.exec('create table if not exists content_removed(id text primary key,removed_at integer)');
 let previous,match;
 db.function('feed_content_blocked',(title,text,context,serialized)=>{
   if(previous!==serialized){previous=serialized;match=compileExclusions(JSON.parse(serialized));}
   return match({title,text,context})?1:0;
 });
}
export function contentExclusionSql(policy={}) {
 const topics=policy.blockedTopics||[];
 if(!topics.length&&!policy.blockedSourceNames?.length&&!policy.blockedTerms?.length)return {sql:'0',args:[]};
 const args=[JSON.stringify(policy)];
 let sql='feed_content_blocked(items.title,items.text,items.context,?) = 1';
 if(topics.length){sql+=` or exists (select 1 from item_labels il join labels l on l.id=il.label_id where il.item_id=items.id and il.decided>=0 and l.layer='topic' and l.name collate nocase in (${topics.map(()=>'?').join(',')}))`;args.push(...topics);}
 return {sql:'('+sql+')',args};
}
