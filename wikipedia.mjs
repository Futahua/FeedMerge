// Wikipedia in the feed, beyond the picture of the day: pages related to what your feeds
// are showing, plus random good articles. Both arrive as ordinary web posts (JSON Feed
// captures), so cards, article expansion, search and 7-day retention work as for any source.
//
// Related: Cloudflare AI names specific subjects in recent posts (or, without AI, the entity
// and place labels are used); each subject is matched to an article by Wikipedia search, then
// its neighbours come from search's morelike: mode, Wikipedia's own replacement for the
// retired page/related endpoint.
// Random: a random member of the quality-reviewed article categories (plain random pages
// are mostly lists and stubs).
// A page is not shown again for 60 days (related) or a year (random).
//
// Wikipedia's 2026 rate limits give identified clients 200 requests/minute; FeedMerge
// identifies itself with the contact in config.json (wikipedia.contact). A run uses ~20.

const RUN_EVERY = 4 * 3600e3;
const PER_RUN = { related: 3, random: 1 };
const FORGET = { related: 60 * 864e5, random: 365 * 864e5 }; // after this, a shown page may be shown again
const RANDOM_CATS = { en: ['Featured articles', 'Good articles'], vi: ['Bài viết chọn lọc'] };
const LETTERS = { en: 'ABCDEFGHIJKLMNOPRSTW', vi: 'ABCDĐGHKLMNPQSTV' };

export function initWikipedia(db) {
  db.exec(`create table if not exists wiki_seen (lang text, title text, kind text, subject text, shown_at integer, primary key (lang, title))`);
}

function agent(readConfig) {
  const contact = readConfig().wikipedia?.contact;
  return `FeedMerge/0.2 (personal feed reader${contact ? '; ' + contact : ''})`;
}

async function api(lang, params, readConfig) {
  const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  for (const [k, v] of Object.entries({ action: 'query', format: 'json', formatversion: '2', ...params })) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { 'user-agent': agent(readConfig), 'api-user-agent': agent(readConfig) }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Wikipedia ${lang} HTTP ${res.status}`);
  return res.json();
}

const PAGE_PROPS = { prop: 'pageimages|description|extracts|info', inprop: 'url', piprop: 'thumbnail', pithumbsize: '1280', exintro: '1', explaintext: '1', exsentences: '4' };

// Pages for a set of titles, or from a generator, with what a card needs.
async function pages(lang, params, readConfig) {
  const j = await api(lang, { ...PAGE_PROPS, ...params }, readConfig);
  return (j.query?.pages || []).filter(p => !p.missing && p.ns === 0 && (p.extract || '').length > 120)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

const toEntry = (p, lang, why) => ({
  id: `${lang}:${p.title}`,
  url: p.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
  title: p.title,
  content_text: [p.description ? p.description[0].toUpperCase() + p.description.slice(1) + '.' : '', p.extract, why].filter(Boolean).join('\n\n'),
  image: p.thumbnail?.source,
  date_published: new Date().toISOString(),
});

export function startWikipedia(db, ingest, log, readConfig, ai) {
  initWikipedia(db);
  const seen = db.prepare('select 1 from wiki_seen where lang = ? and title = ?');
  const mark = db.prepare('insert or ignore into wiki_seen(lang, title, kind, subject, shown_at) values (?, ?, ?, ?, ?)');
  const fresh = (lang, p) => !seen.get(lang, p.title);

  // Specific subjects from what the feeds showed lately, most engaged first.
  async function subjects() {
    const posts = db.prepare(`select coalesce(title, '') || ' ' || coalesce(text, '') t from items
      where last_seen > ? and platform != 'web' and coalesce(json_extract(flags, '$.ad'), 0) = 0 and length(coalesce(title, '') || coalesce(text, '')) > 20
      order by saved * 5 + seen_count + (select count(*) from item_labels il where il.item_id = items.id and il.decided = 1) * 3 desc, last_seen desc limit 40`)
      .all(Date.now() - 3 * 864e5).map(r => '- ' + r.t.replace(/\s+/g, ' ').slice(0, 160));
    if (ai?.active() && posts.length) {
      try {
        const out = await ai.ask([
          { role: 'system', content: 'You pick encyclopedia topics. Return only JSON.' },
          { role: 'user', content: `Recent posts from someone's social feeds:\n${posts.join('\n')}\n\nList 8 specific subjects from these posts that have their own Wikipedia article (people, works, places, organisations, technologies, events, species, buildings; not broad fields like "music" or "politics"). Use "vi" for Vietnamese subjects best covered by Vietnamese Wikipedia, otherwise "en". JSON: {"subjects":[{"name":"article title","lang":"vi|en"}]}` },
        ], 500);
        const j = JSON.parse(/\{[\s\S]*\}/.exec(out)?.[0] || '{}');
        const list = (j.subjects || []).filter(s => typeof s?.name === 'string' && s.name.length > 1).map(s => ({ name: s.name.slice(0, 80), lang: s.lang === 'vi' ? 'vi' : 'en' }));
        if (list.length) return list;
        log('wikipedia subjects', 'AI gave none, using labels');
      } catch (e) { log('wikipedia subjects', e.message); }
    }
    // Without AI: the specific labels (people, organisations, places) on recent posts.
    return db.prepare(`select l.name, count(*) n from item_labels il join labels l on l.id = il.label_id join items i on i.id = il.item_id
      where l.layer in ('entity', 'place') and il.decided >= 0 and i.last_seen > ? group by l.id order by n desc limit 8`)
      .all(Date.now() - 3 * 864e5).map(r => ({ name: r.name, lang: /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(r.name) ? 'vi' : 'en' }));
  }

  async function related() {
    const out = [];
    const list = (await subjects()).sort(() => Math.random() - 0.5);
    for (const s of list) {
      if (out.length >= Number(readConfig().wikipedia?.relatedPerRun ?? PER_RUN.related)) break;
      try {
        const hit = (await api(s.lang, { list: 'search', srsearch: s.name, srlimit: '1', srnamespace: '0' }, readConfig)).query?.search?.[0];
        if (!hit) continue;
        // The subject's own article if new, else its closest unseen neighbour; one per subject
        // so no single topic fills the feed.
        const own = (await pages(s.lang, { titles: hit.title }, readConfig)).filter(p => fresh(s.lang, p));
        const near = own.length ? [] : (await pages(s.lang, { generator: 'search', gsrsearch: `morelike:${hit.title}`, gsrlimit: '8', gsrnamespace: '0' }, readConfig)).filter(p => fresh(s.lang, p));
        const p = own[0] || near[0];
        if (!p) continue;
        out.push(toEntry(p, s.lang, own.length ? `In your feed: ${s.name}` : `Related to ${hit.title}, from your feed`));
        mark.run(s.lang, p.title, 'related', s.name, Date.now());
      } catch (e) { log('wikipedia related', s.name, e.message); }
    }
    return out;
  }

  async function random() {
    const out = [];
    for (let tries = 0; tries < 4 && out.length < Number(readConfig().wikipedia?.randomPerRun ?? PER_RUN.random); tries++) {
      const lang = Math.random() < 0.5 ? 'vi' : 'en';
      const cat = RANDOM_CATS[lang][Math.floor(Math.random() * RANDOM_CATS[lang].length)];
      const L = LETTERS[lang];
      const prefix = L[Math.floor(Math.random() * L.length)] + 'AEIOUNRH'[Math.floor(Math.random() * 8)];
      try {
        const members = (await api(lang, { list: 'categorymembers', cmtitle: `Category:${cat}`, cmnamespace: '0', cmlimit: '10', cmstartsortkeyprefix: prefix }, readConfig)).query?.categorymembers || [];
        const available = members.filter(m => !seen.get(lang, m.title));
        const pick = available[Math.floor(Math.random() * Math.min(5, available.length))];
        if (!pick) continue;
        const [p] = await pages(lang, { titles: pick.title }, readConfig);
        if (!p) continue;
        out.push(toEntry(p, lang, ''));
        mark.run(lang, p.title, 'random', null, Date.now());
      } catch (e) { log('wikipedia random', e.message); }
    }
    return out;
  }

  const feed = (name, items) => {
    if (!items.length) return;
    const r = ingest({ platform: 'web', kind: 'feed', url: 'wikipedia:' + name, pageUrl: `source:Wikipedia · ${name}`, capturedAt: Date.now(),
      payload: JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: `Wikipedia · ${name}`, items }) });
    log('wikipedia', name, `+${r.added}/${r.parsed}`);
  };

  let running = false;
  async function run() {
    const cfg=readConfig().wikipedia || {};
    if (cfg.enabled === false) return {skipped:'disabled'};
    if(running)throw Error('Wikipedia collection already running.');
    running=true;
    try {
    db.prepare("insert into meta(k, v) values ('wikipedia_last', ?) on conflict(k) do update set v = excluded.v").run(String(Date.now()));
    // Shown pages may come back after a while: related ones when an interest returns,
    // random ones once the (small, for Vietnamese) quality pools would otherwise run dry.
    db.prepare("delete from wiki_seen where (kind = 'related' and shown_at < ?) or (kind = 'random' and shown_at < ?)").run(Date.now() - Number(cfg.relatedRepeatDays ?? 60)*864e5, Date.now() - Number(cfg.randomRepeatDays ?? 365)*864e5);
    if(Number(cfg.relatedPerRun ?? 3)>0)feed('for you', await related());
    if(Number(cfg.randomPerRun ?? 1)>0)feed('random', await random());
    return {done:true};
    } finally {running=false;}
  }

  const due = () => Date.now() - Number(db.prepare("select v from meta where k = 'wikipedia_last'").get()?.v || 0) >= Number(readConfig().wikipedia?.intervalHours ?? 4)*3600e3;
  const tick = () => { if (due()) run().catch(e => log('wikipedia', e.message)); };
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, 15 * 60_000).unref?.();
  return { run };
}
