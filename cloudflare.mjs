// Cloudflare Workers AI provider:
//  - bge-m3 embeddings for every post (multilingual): stories, similar posts, learning from your fixes
//  - Clef Flash decisions for the category layers, with probabilities
// Stays inside a daily budget so it runs on the free allowance. Capture and viewing never wait on it.
import { setMachineLabels } from './categorize.mjs';

const EMBED_MODEL = '@cf/baai/bge-m3';
const DECIDE_MODEL = '@cf/cloudflare/clef-flash';
const NEURONS = { embed: 1075 / 1e6, decide: 3455 / 1e6, ask: 4119 / 1e6, askOut: 34868 / 1e6 }; // per token (Workers AI pricing page)
const ASK_MODEL = '@cf/meta/llama-3.1-8b-instruct'; // small text model for short jobs (Wikipedia subjects)
const CF_VERSION = 1; // bump to re-run decisions on everything

export function initCloudflare(db) {
  db.exec(`create table if not exists embeddings (item_id text primary key, vec blob, created integer);
    create table if not exists story_edges (a text, b text, sim real, primary key (a, b));
    create index if not exists story_edges_b on story_edges(b);
    create table if not exists ai_usage (day text primary key, neurons real default 0, calls integer default 0);`);
  const cols = db.prepare('pragma table_info(items)').all().map(c => c.name);
  if (!cols.includes('cf_done')) db.exec('alter table items add column cf_done integer default 0');
}

const today = () => new Date().toISOString().slice(0, 10);
const norm = v => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, x => x / s); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const toVec = buf => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const textOf = it => `${it.title ? it.title + '\n' : ''}${it.text || ''}`.replace(/https?:\/\/\S+/g, '').trim().slice(0, 1500);
// Short replies ("Yes.", "WTF!") look alike without being about the same news: keep them out of stories.
const storyWorthy = it => `${it.title || ''} ${it.text || ''}`.replace(/https?:\/\/\S+|@[\w.]+|#[\p{L}\p{N}_]+/gu, '').replace(/[\s\p{P}\p{S}]+/gu, ' ').trim().length >= 40;

export function cloudflareConfig(readConfig) {
  const c = readConfig().cloudflare || {};
  return c.accountId && c.apiToken && c.enabled !== false ? c : null;
}

export function startCloudflare(db, readConfig, log, hooks = {}) {
  initCloudflare(db);
  const usage = {
    get: () => db.prepare('select neurons from ai_usage where day = ?').get(today())?.neurons || 0,
    add: n => db.prepare('insert into ai_usage(day, neurons, calls) values (?, ?, 1) on conflict(day) do update set neurons = neurons + excluded.neurons, calls = calls + 1').run(today(), n),
  };

  async function run(cfg, model, body) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run/${model}`, {
      method: 'POST', headers: { authorization: `Bearer ${cfg.apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw Object.assign(new Error(`${model} HTTP ${res.status} ${(j.errors || []).map(e => e.message).join('; ')}`.trim()), { status: res.status });
    return j.result;
  }

  // ---------- Embeddings + story edges ----------
  // Only posts a feed showed in the last 2 days use the AI budget: the feed is about now.
  const RECENT = 2 * 864e5;
  const needEmbedQ = db.prepare(`select i.id, i.title, i.text from items i left join embeddings e on e.item_id = i.id where e.item_id is null and i.last_seen > ? order by i.first_seen desc limit 50`);
  const needEmbed = { all: () => needEmbedQ.all(Date.now() - RECENT), get: () => needEmbedQ.get(Date.now() - RECENT) };
  const putEmbed = db.prepare('insert or replace into embeddings(item_id, vec, created) values (?, ?, ?)');
  const windowVecs = db.prepare(`select e.item_id id, e.vec, i.author, i.platform, i.title, i.text from embeddings e join items i on i.id = e.item_id
    where e.vec is not null and i.first_seen > ? and coalesce(json_extract(i.flags, '$.ad'), 0) = 0`);
  const putEdge = db.prepare('insert or replace into story_edges(a, b, sim) values (?, ?, ?)');
  const link = (a, b, s) => { if (s >= 0.7) putEdge.run(a < b ? a : b, a < b ? b : a, s); };

  // One-time (and on demand) rebuild of all candidate links in the window.
  function rebuildEdges() {
    const all = windowVecs.all(Date.now() - 4 * 864e5).filter(storyWorthy).map(r => ({ ...r, v: toVec(r.vec) }));
    db.exec('begin');
    try {
      db.exec('delete from story_edges');
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) link(all[i].id, all[j].id, dot(all[i].v, all[j].v));
      db.exec("insert into meta(k, v) values ('edges_v2', '1') on conflict(k) do update set v = '1'");
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
    log('story links rebuilt over', all.length, 'posts');
  }

  async function embedBatch(cfg) {
    const rows = needEmbed.all();
    if (!rows.length) return 0;
    const withText = rows.filter(r => textOf(r).length >= 12);
    const now = Date.now();
    let vecs = [];
    if (withText.length) {
      const result = await run(cfg, EMBED_MODEL, { text: withText.map(textOf) });
      vecs = result.data.map(norm);
      usage.add(withText.reduce((s, r) => s + textOf(r).length / 3, 0) * NEURONS.embed);
    }
    // Link each new post to similar posts from the last 4 days, including others in this batch.
    const recent = windowVecs.all(Date.now() - 4 * 864e5).filter(storyWorthy).map(r => ({ ...r, v: toVec(r.vec) }));
    db.exec('begin');
    try {
      for (const r of rows.filter(r => !withText.includes(r))) putEmbed.run(r.id, null, now);
      const fresh = [];
      withText.forEach((r, i) => {
        const v = vecs[i];
        putEmbed.run(r.id, Buffer.from(v.buffer), now);
        if (!storyWorthy(r)) return;
        for (const o of recent) if (o.id !== r.id) link(r.id, o.id, dot(v, o.v));
        for (const o of fresh) link(r.id, o.id, dot(v, o.v));
        fresh.push({ id: r.id, v });
      });
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
    return rows.length;
  }

  // ---------- Clef Flash categories ----------
  const needDecide = db.prepare(`select id, platform, author, author_name, title, text, context from items
    where cf_done < ? and last_seen > ? and coalesce(json_extract(flags, '$.ad'), 0) = 0 order by first_seen desc limit 1`);
  const markDone = db.prepare('update items set cf_done = ? where id = ?');

  function questionsFor() {
    const labels = db.prepare("select id, layer, name, description, keywords from labels where layer in ('topic', 'place', 'entity') order by layer, name").all();
    const layer = l => labels.filter(x => x.layer === l);
    const crit = list => {
      const c = {};
      for (const x of list) {
        const kw = x.keywords ? JSON.parse(x.keywords).filter(k => !k.startsWith('=')).slice(0, 6).join(', ') : '';
        c[x.name] = [x.description && !/^(What|Where|Specific)/.test(x.description) ? x.description : '', kw ? `e.g. ${kw}` : ''].filter(Boolean).join('; ') || x.name;
      }
      c.none = 'None of these';
      return c;
    };
    return {
      topic: { type: 'choice', instructions: 'Which topic is this post mainly about?', criteria: crit(layer('topic')) },
      place: { type: 'choice', instructions: 'Which place is this post set in or about? Choose none if no specific place.', criteria: crit(layer('place')) },
      entity: { type: 'choice', instructions: 'Which person or organisation is this post mainly about? Choose none if none of these.', criteria: crit(layer('entity')) },
    };
  }

  async function decideOne(cfg, it, questions) {
    const state = { platform: it.platform, author: it.author_name || it.author || '', title: it.title || undefined, text: (it.text || '').slice(0, 1200) };
    const result = await run(cfg, DECIDE_MODEL, { state, questions });
    usage.add((result.usage?.input_tokens || 600) * NEURONS.decide);
    const answers = result.answers || {};
    db.exec('begin');
    try {
      for (const layer of ['topic', 'place', 'entity']) {
        const a = answers[layer];
        const probs = a?.probabilities || (a?.choice ? { [a.choice]: 1 } : {});
        // Multi-label: keep every option the model gives real weight to.
        const picked = Object.entries(probs).filter(([name, p]) => name !== 'none' && p >= 0.25).sort((x, y) => y[1] - x[1]).slice(0, layer === 'topic' ? 3 : 2);
        setMachineLabels(db, it.id, layer, picked.map(([name, prob]) => ({ name, prob: Math.round(prob * 1000) / 1000 })), 'ai');
      }
      markDone.run(CF_VERSION, it.id);
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
  }

  // ---------- Loop with budget + backoff ----------
  let backoff = 0;
  let busy = false;
  async function tick() {
    if (busy) return;
    const cfg = cloudflareConfig(readConfig);
    if (!cfg) return;
    busy = true;
    const cap = Number(cfg.dailyNeuronCap) || 9000;
    try {
      let embedded = 0, decided = 0;
      for (let i = 0; i < 6 && usage.get() < cap; i++) { const n = await embedBatch(cfg); embedded += n; if (!n) break; }
      if (!db.prepare("select v from meta where k = 'edges_v2'").get() && !needEmbed.get()) { rebuildEdges(); hooks.onEmbedded?.(); }
      if (embedded) hooks.onEmbedded?.();
      if (cfg.categorize !== false) {
        const questions = questionsFor();
        for (let i = 0; i < 40 && usage.get() < cap; i++) {
          const it = needDecide.get(CF_VERSION, Date.now() - RECENT);
          if (!it) break;
          // Nearly empty posts (emoji-only captions, bare links) aren't worth a call; rules keep their labels.
          if (`${it.title || ''} ${it.text || ''}`.replace(/https?:\/\/\S+|[\s\p{P}\p{S}]+/gu, '').length < 8) { markDone.run(CF_VERSION, it.id); continue; }
          await decideOne(cfg, it, questions);
          decided++;
        }
      }
      if (embedded || decided) log('cloudflare', `embedded ${embedded}, categorized ${decided}, today ${Math.round(usage.get())}/${cap} neurons`);
      backoff = 0;
    } catch (e) {
      backoff = Math.min(backoff ? backoff * 2 : 60_000, 30 * 60_000);
      log('cloudflare error', e.message, `pausing ${Math.round(backoff / 1000)}s`);
    } finally { busy = false; }
  }
  const loop = () => { tick().finally(() => setTimeout(loop, backoff || 30_000).unref?.()); };
  setTimeout(loop, 4_000).unref?.();

  return {
    active: () => !!cloudflareConfig(readConfig),
    // A short text answer, inside the same daily budget.
    ask: async (messages, maxTokens = 400) => {
      const cfg = cloudflareConfig(readConfig);
      if (!cfg) throw new Error('Cloudflare AI is off');
      const cap = Number(cfg.dailyNeuronCap) || 9000;
      if (usage.get() >= cap) throw new Error('daily AI budget used');
      const r = await run(cfg, ASK_MODEL, { messages, max_tokens: maxTokens });
      usage.add(r.usage?.neurons ?? ((r.usage?.prompt_tokens || 1500) * NEURONS.ask + (r.usage?.completion_tokens || maxTokens) * NEURONS.askOut));
      // Asked for JSON, the model may answer with the parsed object itself.
      const out = r.response ?? r.choices?.[0]?.message?.content ?? '';
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
    usage: () => ({ today: Math.round(usage.get()), cap: Number(cloudflareConfig(readConfig)?.dailyNeuronCap) || 9000 }),
    labelsChanged: () => db.prepare('update items set cf_done = 0 where first_seen > ?').run(Date.now() - 3 * 864e5),
  };
}

// ---------- Stories from embedding similarity ----------
// Connected posts (similarity >= threshold) over 4 days form a story, if they span
// at least two authors and either two platforms or three posts.
export function embeddingStories(db, log, threshold = 0.82) {
  const since = Date.now() - 4 * 864e5;
  const edges = db.prepare(`select a, b, sim from story_edges where sim >= ? and a in (select id from items where first_seen > ?) and b in (select id from items where first_seen > ?)`).all(threshold, since, since);
  const parent = new Map();
  const find = x => { let p = parent.get(x) ?? x; if (p !== x) { p = find(p); parent.set(x, p); } return p; };
  for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent.set(ra, rb); }
  const groups = new Map();
  for (const id of new Set(edges.flatMap(e => [e.a, e.b]))) { const r = find(id); (groups.get(r) || groups.set(r, []).get(r)).push(id); }
  const info = db.prepare('select id, platform, author, title, text from items where id = ?');
  const vecOf = db.prepare('select vec from embeddings where item_id = ?');
  const stories = [];
  for (const ids of groups.values()) {
    if (ids.length > 80) continue;
    const rows = ids.map(id => info.get(id)).filter(Boolean);
    const platforms = new Set(rows.map(r => r.platform));
    const authors = new Set(rows.map(r => r.author));
    if (rows.length < 2 || authors.size < 2 || (platforms.size < 2 && rows.length < 3)) continue;
    // Name the story after the post closest to the group's centre.
    const vecs = rows.map(r => toVec(vecOf.get(r.id).vec));
    const c = new Float32Array(vecs[0].length);
    for (const v of vecs) for (let i = 0; i < v.length; i++) c[i] += v[i];
    let best = 0, bestS = -1;
    vecs.forEach((v, k) => { const s = dot(v, c); if (s > bestS) { bestS = s; best = k; } });
    const rep = rows[best];
    let name = (rep.title || rep.text || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    if (name.length > 70) name = name.slice(0, 70).replace(/\s+\S*$/, '') + '…';
    stories.push({ name: name || 'Untitled story', items: rows.map(r => r.id), prob: Math.min(0.95, 0.6 + rows.length * 0.04) });
  }
  db.exec('begin');
  try {
    // Keep each story's identity (and any name you or an assistant gave it) across regrouping:
    // a new group reuses the existing story label it overlaps most.
    const prev = new Map();
    for (const r of db.prepare(`select il.label_id id, il.item_id it from item_labels il join labels l on l.id = il.label_id where l.layer = 'story' and il.decided >= 0`).all())
      (prev.get(r.id) || prev.set(r.id, new Set()).get(r.id)).add(r.it);
    db.prepare(`delete from item_labels where decided = 0 and source in ('mock', 'ai') and label_id in (select id from labels where layer = 'story')`).run();
    const getLabel = db.prepare("select id from labels where layer = 'story' and name = ?");
    const mk = db.prepare("insert into labels(layer, name, description, source, created) values ('story', ?, 'Posts across platforms about the same event.', 'ai', ?)");
    const put = db.prepare("insert or ignore into item_labels(item_id, label_id, prob, source, decided, updated) values (?, ?, ?, 'ai', 0, ?)");
    const used = new Set();
    for (const s of stories) {
      let best = null, bestN = 0;
      for (const [id, set] of prev) {
        if (used.has(id)) continue;
        const n = s.items.filter(x => set.has(x)).length;
        if (n > bestN && n * 2 >= Math.min(set.size, s.items.length)) { best = id; bestN = n; }
      }
      const id = best ?? getLabel.get(s.name)?.id ?? mk.run(s.name, Date.now()).lastInsertRowid;
      used.add(id);
      for (const it of s.items) put.run(it, id, s.prob, Date.now());
    }
    db.exec(`delete from labels where layer = 'story' and source in ('mock', 'ai') and id not in (select label_id from item_labels)`);
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  log('stories (embeddings)', stories.length, 'from', edges.length, 'links');
  return stories.length;
}
