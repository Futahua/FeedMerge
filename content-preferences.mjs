// User exclusions: literal topics, source names and whole words/phrases, never code.
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function compileExclusions(policy={}) {
 const topics=new Set((policy.blockedTopics||[]).map(s=>s.toLowerCase()));
 const sources=new Set((policy.blockedSourceNames||[]).map(s=>s.toLowerCase()));
 const words=(policy.blockedTerms||[]).filter(Boolean);
 // One pattern for all terms: testing each term separately over every post took seconds per feed page.
 const terms=words.length?new RegExp('(?:^|[^\\p{L}\\p{N}_])(?:'+words.map(escape).join('|')+')(?=$|[^\\p{L}\\p{N}_])','iu'):null;
 return (item,labels=[])=>sources.has(String(item.context||'').toLowerCase())||labels.some(s=>topics.has(String(s).toLowerCase()))||!!terms?.test(`${item.title||''}\n${item.text||''}`);
}
export function initContentPreferences(db) {
 db.exec('create table if not exists content_removed(id text primary key,removed_at integer)');
 // Every feed page filters every post, so remember each post's answer until its text or the policy changes.
 let previous,match,memo=new Map();
 db.function('feed_content_blocked',(rowid,title,text,context,serialized)=>{
   if(previous!==serialized){previous=serialized;match=compileExclusions(JSON.parse(serialized));memo=new Map();}
   const key=`${context}\n${title}\n${text}`,hit=memo.get(rowid);
   if(hit&&hit.key===key)return hit.blocked;
   const blocked=match({title,text,context})?1:0;
   memo.set(rowid,{key,blocked});
   return blocked;
 });
}
export function contentExclusionSql(policy={}) {
 const topics=policy.blockedTopics||[];
 if(!topics.length&&!policy.blockedSourceNames?.length&&!policy.blockedTerms?.length)return {sql:'0',args:[]};
 const args=[JSON.stringify(policy)];
 let sql='feed_content_blocked(items.rowid,items.title,items.text,items.context,?) = 1';
 if(topics.length){sql+=` or exists (select 1 from item_labels il join labels l on l.id=il.label_id where il.item_id=items.id and il.decided>=0 and l.layer='topic' and l.name collate nocase in (${topics.map(()=>'?').join(',')}))`;args.push(...topics);}
 return {sql:'('+sql+')',args};
}
