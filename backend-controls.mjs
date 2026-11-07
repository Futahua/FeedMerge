// Public control contract. Secrets, URLs, host permissions and agent authority are
// deliberately not configuration fields in this interface.
const number = (fallback,min,max,owner,integer=true) => ({type:'number',default:fallback,min,max,integer,owner});
const boolean = (fallback,owner) => ({type:'boolean',default:fallback,owner});
export const CONTROL_CATALOG = {
 'ai.enabled':boolean(false,'chat classifier'),
 'ai.model':{type:'string',default:'',maxLength:160,owner:'chat classifier'},
 'ai.systemPrompt':{type:'string',default:null,maxLength:12000,owner:'chat classifier'},
 'ai.temperature':number(.2,0,2,'chat classifier',false),
 'ai.batchSize':number(25,1,100,'chat classifier'),
 'ai.intervalSeconds':number(20,5,3600,'chat classifier'),
 'cloudflare.enabled':boolean(true,'Cloudflare worker'),
 'cloudflare.categorize':boolean(true,'Cloudflare worker'),
 'cloudflare.dailyNeuronCap':number(9000,1,100000,'Cloudflare budget'),
 'cloudflare.storyThreshold':number(.8,.5,1,'story clustering',false),
 'cloudflare.embeddingBatches':number(6,1,20,'Cloudflare worker'),
 'cloudflare.classificationBatchSize':number(40,1,200,'Cloudflare worker'),
 'cloudflare.intervalSeconds':number(30,10,3600,'Cloudflare worker'),
 'sources.pollingEnabled':boolean(true,'source poller'),
 'wikipedia.enabled':boolean(true,'Wikipedia source'),
 'wikipedia.intervalHours':number(4,1,168,'Wikipedia source',false),
 'wikipedia.relatedPerRun':number(3,0,8,'Wikipedia source'),
 'wikipedia.randomPerRun':number(1,0,4,'Wikipedia source'),
 'wikipedia.relatedRepeatDays':number(60,1,3650,'Wikipedia source'),
 'wikipedia.randomRepeatDays':number(365,1,3650,'Wikipedia source'),
 'retention.days':{...number(7,1,3650,'retention'),key:'retention_days',env:'FEEDMERGE_RETENTION_DAYS'},
 'retention.rawDays':{...number(3,1,3650,'retention'),key:'retention_raw_days',env:'FEEDMERGE_RETENTION_RAW_DAYS'},
 'retention.adDays':{...number(1,1,3650,'retention'),key:'retention_ad_days',env:'FEEDMERGE_RETENTION_AD_DAYS'},
 'viewer.defaultCardWidth':number(440,240,1000,'viewer defaults'),
 'viewer.xTextMaxHeight':number(320,100,1200,'viewer defaults'),
 'viewer.facebookTextMaxHeight':number(440,100,1200,'viewer defaults'),
 'capture.enabled':boolean(true,'browser scheduler'),
 'capture.quietFrom':number(1,0,23,'browser scheduler'),
 'capture.quietTo':number(7,0,23,'browser scheduler'),
};
const defaults={reddit:2,youtube:3,x:3,facebook:4,instagram:4,threads:4,pinterest:18,tiktok:4};
for(const [platform,hours] of Object.entries(defaults)) {
 CONTROL_CATALOG[`viewer.platforms.${platform}.keepPercent`]=number(platform==='pinterest'?40:100,0,100,'mixed feed');
 CONTROL_CATALOG[`capture.platforms.${platform}.hours`]=number(hours,.5,168,'browser scheduler',false);
 CONTROL_CATALOG[`capture.platforms.${platform}.scrolls`]=number(platform==='pinterest'?3:8,0,30,'browser scheduler');
 CONTROL_CATALOG[`capture.platforms.${platform}.on`]=boolean(true,'browser scheduler');
}
for(const platform of ['web','bluesky'])CONTROL_CATALOG[`viewer.platforms.${platform}.keepPercent`]=number(100,0,100,'mixed feed');
export const settingKey = name => CONTROL_CATALOG[name]?.key || 'control:' + name;
export function normalizeControlChanges(changes) {
 if(!changes || typeof changes!=='object' || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).length>60)throw Error('Supply 1–60 named control changes.');
 const result={};
 for(const [name,value] of Object.entries(changes)) {
   const spec=CONTROL_CATALOG[name];if(!spec)throw Error(`Unknown or noneditable control: ${name}`);
   if(spec.env && process.env[spec.env]!==undefined)throw Error(`${name} is locked by the local environment.`);
   if(value!==null && (typeof value!==spec.type || spec.type==='number'&&(!Number.isFinite(value)||value<spec.min||value>spec.max||spec.integer&&!Number.isInteger(value)) || spec.type==='string'&&(!value.trim()||value.length>spec.maxLength)))throw Error(`Invalid value for ${name}.`);
   result[name]=value; // null removes an override, restoring the owner's normal default
 }
 return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
export function applyControlOverrides(db,config) {
 const result=structuredClone(config);
 if(!db)return result;
 const overrides=new Map(db.prepare("select k,v from meta where k like 'control:%'").all().map(row=>[row.k,row.v]));
 for(const [name,spec] of Object.entries(CONTROL_CATALOG)) {
   if(spec.key)continue; // retention already reads these same meta keys
   const row=overrides.get(settingKey(name));if(row===undefined)continue;
   const parts=name.split('.');let target=result;
   for(const part of parts.slice(0,-1))target=target[part]??={};
   target[parts.at(-1)]=JSON.parse(row);
 }
 return result;
}
export function controlCatalog(db,config) {
 return Object.entries(CONTROL_CATALOG).map(([name,spec])=>{
   const row=db.prepare('select v from meta where k=?').get(settingKey(name));
   let value=name.split('.').reduce((o,k)=>o?.[k],config)??spec.default;
   if(spec.key&&row)value=Number(row.v);
   if(spec.env&&process.env[spec.env]!==undefined)value=Number(process.env[spec.env]);
   return {name,...spec,value,overridden:!!row,locked:!!(spec.env&&process.env[spec.env]!==undefined),effect:name.startsWith('capture.')?'after extension reload / next scheduler check':name.startsWith('viewer.')?'next viewer reload':'next owner cycle'};
 });
}
