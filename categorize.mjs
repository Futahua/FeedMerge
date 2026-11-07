// Category layers. The labels and assignments live here; providers fill them.
// Today: a "mock" provider (keyword rules + simple story clustering) so the whole UI works
// without an AI key. Later an AI provider writes into the same tables with source = 'ai'.
// Your own decisions (decided = 1 confirm / -1 reject) are never overwritten by a provider.

export const LAYERS = [
  { id: 'topic', name: 'Topics', sort: 1 },
  { id: 'story', name: 'Stories', sort: 2 },
  { id: 'place', name: 'Places', sort: 3 },
  { id: 'entity', name: 'People & orgs', sort: 4 },
  { id: 'format', name: 'Format', sort: 5 },
];

// Bump when mock rules change so every item is re-categorized.
const CAT_VERSION = 3;

// Keywords: lowercase match on word boundaries; "=Word" matches case-sensitively.
// Vietnamese keywords also match text typed without diacritics.
const MOCK = {
  topic: {
    'AI & Computing': ['=AI', 'a.i.', 'artificial intelligence', 'llm', 'gpt', 'chatgpt', 'openai', 'claude', 'gemini', 'nvidia', 'gpu', 'rtx', 'cpu', 'chip', 'robot', 'machine learning', 'trí tuệ nhân tạo', 'máy tính', 'công nghệ', 'laptop', 'software'],
    Gaming: ['game', 'games', 'gaming', 'gamer', 'gta', 'steam', 'playstation', 'ps5', 'xbox', 'nintendo', 'esports', 'minecraft', 'valorant', 'liên quân', 'trò chơi'],
    'Food & Cooking': ['recipe', 'cooking', 'food', 'delicious', 'restaurant', 'món ăn', 'nấu', 'bếp', 'ngon', 'phở', 'bánh mì', 'cơm', 'đồ ăn', 'bia'],
    Music: ['song', 'music', 'album', 'concert', 'singer', 'rapper', 'playlist', 'nhạc', 'bài hát', 'ca sĩ', '=MV'],
    'Science & Nature': ['science', 'physics', 'physicist', 'space', 'nasa', 'planet', 'animal', 'animals', 'nature', 'wildlife', 'cobra', 'snake', 'khoa học', 'vũ trụ', 'động vật', 'thiên nhiên'],
    'Architecture & Design': ['architecture', 'architect', 'building', 'interior', 'revit', 'skyscraper', 'kiến trúc', 'nội thất', 'thiết kế', 'sân bay'],
    'Money & Markets': ['price', 'prices', 'stock', 'stocks', 'market', 'economy', 'bitcoin', 'crypto', 'inflation', 'giá', 'chứng khoán', 'kinh tế', 'đầu tư'],
    'Politics & World': ['election', 'president', 'government', 'war', 'minister', 'congress', 'senate', 'chính phủ', 'bầu cử', 'chiến tranh', 'thủ tướng', 'quốc hội', 'tổng thống'],
    'Humor & Memes': ['meme', 'memes', 'funny', 'lol', 'lmao', '😂', '🤣', 'hài', 'buồn cười'],
    Sports: ['football', 'soccer', 'nba', 'formula 1', '=F1', 'goal', 'bóng đá', 'world cup', 'messi', 'ronaldo', 'tennis'],
  },
  place: {
    Vietnam: ['vietnam', 'việt nam', 'vietnamese', 'người việt'],
    Hanoi: ['hà nội', 'hanoi'],
    'Ho Chi Minh City': ['sài gòn', 'saigon', 'hồ chí minh', 'tp.hcm', 'tphcm', 'hcmc'],
    'Da Nang': ['đà nẵng', 'da nang', 'danang'],
    'United States': ['usa', 'u.s.', 'america', 'american', 'hoa kỳ', 'nước mỹ', 'người mỹ', 'tổng thống mỹ', '=US'],
    China: ['china', 'chinese', 'trung quốc', 'beijing', 'bắc kinh', 'shanghai'],
    Japan: ['japan', 'japanese', 'nhật bản', 'tokyo'],
    'South Korea': ['korea', 'korean', 'hàn quốc', 'seoul'],
    'United Kingdom': ['=UK', 'britain', 'british', 'london', 'anh quốc'],
    Europe: ['europe', 'european', '=EU', 'châu âu'],
    Thailand: ['thailand', 'thai', 'thái lan', 'bangkok'],
  },
  entity: {
    Nvidia: ['nvidia'],
    OpenAI: ['openai', 'chatgpt', 'sam altman'],
    Google: ['google', 'gemini', 'youtube premium'],
    Apple: ['apple', 'iphone', 'macbook', 'ipad'],
    Microsoft: ['microsoft', 'windows 11', 'xbox'],
    Meta: ['=Meta', 'zuckerberg'],
    Tesla: ['tesla'],
    'Elon Musk': ['elon musk', 'elon'],
    'Donald Trump': ['trump'],
    Samsung: ['samsung', 'galaxy s'],
    VinFast: ['vinfast', 'vingroup'],
  },
};

const DESCRIPTIONS = {
  topic: 'What the post is about.',
  place: 'Where the post is set or which country/city it concerns.',
  entity: 'Specific people, companies or organisations mentioned.',
};

const strip = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(keywords) {
  return keywords.map(k => {
    const cs = k.startsWith('=');
    const word = cs ? k.slice(1) : k.toLowerCase();
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(word)}(?![\\p{L}\\p{N}])`, cs ? 'u' : 'iu');
    const hasMarks = !cs && strip(word) !== word;
    const re2 = hasMarks ? new RegExp(`(?<![\\p{L}\\p{N}])${esc(strip(word))}(?![\\p{L}\\p{N}])`, 'iu') : null;
    return { re, re2 };
  });
}

export function initCategories(db) {
  db.exec(`
    create table if not exists layers (id text primary key, name text, sort integer);
    create table if not exists labels (id integer primary key, layer text, name text, description text, keywords text, source text, created integer, unique(layer, name));
    create table if not exists item_labels (item_id text, label_id integer, prob real, source text, decided integer default 0, updated integer, primary key (item_id, label_id));
    create index if not exists item_labels_label on item_labels(label_id);
  `);
  const cols = db.prepare('pragma table_info(items)').all().map(c => c.name);
  if (!cols.includes('cat_done')) db.exec('alter table items add column cat_done integer default 0');
  const upLayer = db.prepare('insert into layers(id, name, sort) values (?, ?, ?) on conflict(id) do update set name = excluded.name, sort = excluded.sort');
  for (const l of LAYERS) upLayer.run(l.id, l.name, l.sort);
  // Seed the mock labels once, so labels you delete or rename stay that way.
  db.exec('create table if not exists meta (k text primary key, v text)');
  if (!db.prepare("select v from meta where k = 'mock_seeded'").get()) {
    const ins = db.prepare('insert or ignore into labels(layer, name, description, keywords, source, created) values (?, ?, ?, ?, ?, ?)');
    for (const [layer, labels] of Object.entries(MOCK)) for (const [name, kw] of Object.entries(labels)) ins.run(layer, name, DESCRIPTIONS[layer], JSON.stringify(kw), 'mock', Date.now());
    for (const name of ['Video', 'Short video', 'Photo', 'Gallery', 'Text post', 'Article', 'Discussion']) ins.run('format', name, 'What kind of post it is.', null, 'rule', Date.now());
    db.prepare("insert into meta(k, v) values ('mock_seeded', ?)").run(String(Date.now()));
  }
}

// Replace machine labels of one layer for an item, keeping your confirmations/rejections.
export function setMachineLabels(db, itemId, layer, labels, source) {
  const now = Date.now();
  // Only replace other machine guesses; your decisions and assistant suggestions stay.
  db.prepare(`delete from item_labels where item_id = ? and decided = 0 and source in ('mock', 'ai', 'rule') and label_id in (select id from labels where layer = ?)`).run(itemId, layer);
  const getLabel = db.prepare('select id from labels where layer = ? and name = ?');
  const mk = db.prepare('insert into labels(layer, name, description, source, created) values (?, ?, ?, ?, ?)');
  const put = db.prepare('insert or ignore into item_labels(item_id, label_id, prob, source, decided, updated) values (?, ?, ?, ?, 0, ?)');
  for (const l of labels) {
    let id = getLabel.get(layer, l.name)?.id;
    if (id == null) id = mk.run(layer, l.name, l.description || null, source, now).lastInsertRowid;
    put.run(itemId, id, l.prob, source, now);
  }
}

function formatOf(it) {
  const media = JSON.parse(it.media || '[]');
  const flags = JSON.parse(it.flags || '{}');
  if (it.platform === 'web') return 'Article';
  if (it.platform === 'tiktok' || flags.reel || flags.short || it.context === 'shorts' || it.context === 'reels') return media.some(m => m.type === 'image') && media.length > 1 ? 'Gallery' : 'Short video';
  if (it.platform === 'youtube' || media.some(m => m.type === 'video' || m.type === 'gif')) return 'Video';
  if (media.filter(m => m.type === 'image').length > 1) return 'Gallery';
  if (media.some(m => m.type === 'image')) return 'Photo';
  if (it.platform === 'reddit' && Number(JSON.parse(it.metrics || '{}').comments) > 20) return 'Discussion';
  return 'Text post';
}

export function startCategorizer(db, log, opts = {}) {
  let rules = null;
  const loadRules = () => {
    rules = db.prepare("select id, layer, name, keywords from labels where keywords is not null and layer in ('topic', 'place', 'entity')").all()
      .map(r => ({ ...r, matchers: compile(JSON.parse(r.keywords)) }));
  };
  loadRules();
  const hasCf = db.prepare('pragma table_info(items)').all().some(c => c.name === 'cf_done');
  const pending = db.prepare(`select id, platform, context, title, text, author, media, flags, metrics, ${hasCf ? 'cf_done' : '0 as cf_done'} from items where cat_done < ? order by first_seen desc limit 400`);
  const done = db.prepare('update items set cat_done = ? where id = ?');

  function categorizeOne(it) {
    const raw = `${it.title || ''}\n${it.text || ''}`;
    const lower = raw.toLowerCase();
    const plain = strip(lower);
    const byLayer = { topic: [], place: [], entity: [] };
    for (const r of rules) {
      let hits = 0;
      for (const m of r.matchers) if (m.re.test(m.re.flags.includes('i') ? lower : raw) || (m.re2 && m.re2.test(plain))) hits++;
      if (hits) byLayer[r.layer].push({ name: r.name, prob: hits >= 3 ? 0.9 : hits === 2 ? 0.75 : 0.58 });
    }
    // Once the AI provider has categorized a post, keyword rules no longer touch it.
    if (!it.cf_done) for (const layer of Object.keys(byLayer)) {
      const top = byLayer[layer].sort((a, b) => b.prob - a.prob).slice(0, layer === 'topic' ? 3 : 4);
      setMachineLabels(db, it.id, layer, top, 'mock');
    }
    setMachineLabels(db, it.id, 'format', [{ name: formatOf(it), prob: 1 }], 'rule');
  }

  function runBatch() {
    const rows = pending.all(CAT_VERSION);
    if (!rows.length) return 0;
    db.exec('begin');
    try { for (const it of rows) { categorizeOne(it); done.run(CAT_VERSION, it.id); } db.exec('commit'); }
    catch (e) { db.exec('rollback'); log('categorize error', e.message); return 0; }
    return rows.length;
  }

  let storiesDirty = true;
  function reclusterNow() {
    if(opts.aiActive?.())opts.aiStories();else clusterStories(db,log);
    storiesDirty=false;
    return {stories:db.prepare("select count(*) n from labels where layer='story'").get().n};
  }
  function tick() {
    let n = 0, k;
    while ((k = runBatch()) > 0 && n < 4000) n += k;
    if (n) { log('categorized', n); storiesDirty = true; }
    if (storiesDirty) {
      try { reclusterNow(); } catch (e) { log('stories error', e.message); }
      storiesDirty = false;
    }
  }
  setInterval(tick, 20_000).unref?.();
  setTimeout(tick, 2_000).unref?.();
  return { rulesChanged() { loadRules(); db.prepare('update items set cat_done = 0').run(); storiesDirty = true; }, recluster() { storiesDirty = true; }, reclusterNow };
}

// ---------- Mock story clustering ----------
// Posts from the last 4 days that share several distinctive words/phrases are grouped.
// A real provider replaces this with embedding similarity; the tables stay the same.
const STOP = new Set(('the a an and or but of to in on at for with from by is are was were be been this that these those it its as not no yes you your we our they their he she his her i me my just so if then than more most very can will would should could about into over after before what when where who why how all any some one two new also out up down off only own same too much many such here there have has had do does did get got like now via amp https http www com rt '
  + 'first time times even people know think really still back make made good need want going right never every thing things look today year years day days video videos watch post comment comments love best last next take come thank thanks please follow life world great little long much well way being because while '
  + 'và của là có được cho với một những các này đó khi đã đang sẽ không thì mà để trong trên ngoài như người năm ngày theo về tại từ ra vào lại cũng rất nhiều hơn nhất phải còn nên bị bạn tôi chúng ta họ anh chị em nó gì nào ai sao đây đấy ở hay hoặc nhưng nếu vì do bởi thế rồi chỉ mới vẫn đều cả').split(/\s+/));

function tokens(text) {
  const words = (text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[\p{L}\p{N}]+/gu) || [];
  const out = new Set();
  const keep = words.map(w => (STOP.has(w) || w.length < 2 ? null : w));
  for (let i = 0; i < keep.length; i++) {
    const w = keep[i];
    if (!w) continue;
    if (w.length >= 4 || /\d{3,}/.test(w)) out.add(w);
    if (keep[i + 1]) out.add(w + ' ' + keep[i + 1]);
  }
  return out;
}

export function clusterStories(db, log) {
  const since = Date.now() - 4 * 864e5;
  const docs = db.prepare("select id, platform, title, text from items where first_seen > ? and coalesce(json_extract(flags, '$.ad'), 0) = 0").all(since)
    .map(d => ({ ...d, toks: tokens(`${d.title || ''} ${d.text || ''}`) }));
  const df = new Map();
  for (const d of docs) for (const t of d.toks) df.set(t, (df.get(t) || 0) + 1);
  const maxDf = Math.max(6, Math.round(docs.length * 0.02));
  const index = new Map();
  docs.forEach((d, i) => {
    d.key = [...d.toks].filter(t => { const n = df.get(t); return n >= 2 && n <= maxDf; });
    for (const t of d.key) (index.get(t) || index.set(t, []).get(t)).push(i);
  });
  const parent = docs.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  docs.forEach((d, i) => {
    const score = new Map();
    for (const t of d.key) for (const j of index.get(t)) if (j > i) score.set(j, (score.get(j) || 0) + (t.includes(' ') ? 2 : 1));
    for (const [j, s] of score) if (s >= 5) parent[find(j)] = find(i);
  });
  const groups = new Map();
  docs.forEach((d, i) => { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(d); });
  const stories = [];
  for (const g of groups.values()) {
    const platforms = new Set(g.map(d => d.platform));
    if (g.length < 2 || g.length > 60 || (g.length < 3 && platforms.size < 2)) continue;
    const count = new Map();
    for (const d of g) for (const t of d.key) count.set(t, (count.get(t) || 0) + 1);
    const top = [...count].filter(([, n]) => n >= Math.min(2, g.length)).sort((a, b) => (b[1] + (b[0].includes(' ') ? 0.5 : 0)) - (a[1] + (a[0].includes(' ') ? 0.5 : 0)));
    const picked = [];
    for (const [t] of top) { if (picked.some(p => p.includes(t) || t.includes(p))) continue; picked.push(t); if (picked.length === 3) break; }
    if (!picked.length) continue;
    const name = picked.map(t => t.replace(/(^|\s)\p{L}/gu, c => c.toUpperCase())).join(' · ');
    stories.push({ name, items: g.map(d => d.id), prob: Math.min(0.9, 0.5 + g.length * 0.05) });
  }
  db.exec('begin');
  try {
    db.prepare(`delete from item_labels where decided = 0 and source = 'mock' and label_id in (select id from labels where layer = 'story')`).run();
    const getLabel = db.prepare("select id from labels where layer = 'story' and name = ?");
    const mk = db.prepare("insert into labels(layer, name, description, source, created) values ('story', ?, 'Posts across platforms about the same event.', 'mock', ?)");
    const put = db.prepare("insert or ignore into item_labels(item_id, label_id, prob, source, decided, updated) values (?, ?, ?, 'mock', 0, ?)");
    for (const s of stories) {
      const id = getLabel.get(s.name)?.id ?? mk.run(s.name, Date.now()).lastInsertRowid;
      for (const it of s.items) put.run(it, id, s.prob, Date.now());
    }
    db.exec(`delete from labels where layer = 'story' and source = 'mock' and id not in (select label_id from item_labels)`);
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  log('stories', stories.length, 'from', docs.length, 'posts');
}
