import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { balanceWebLanguages, isVietnamese, admitsWebPost } from '../retention.mjs';
import { translateFields, looksEnglish, startTranslator, initTranslations, translatedArticle } from '../translate.mjs';

const VI = 'Thủ tướng chỉ đạo đẩy mạnh giải ngân vốn đầu tư công trong năm nay';
const ES = 'El presidente anunció nuevas medidas económicas para el próximo año';
const EN = 'The president announced new economic measures for the year ahead';

function feed() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table items(id text primary key, platform text, context text, author text, title text, text text, flags text, first_seen int, last_seen int, saved int default 0);
    create virtual table items_fts using fts5(author, title, text);
    create table item_labels(item_id text, label_id int, decided int default 0);
    create table embeddings(item_id text primary key, vec blob);
    create table story_edges(a text, b text, sim real);
    create table post_reviews(item_id text primary key);
    create table articles(item_id text primary key, fetched_at int, ok int, blocks text, error text);
    create table item_accounts(item_id text, profile text, first_seen int, last_seen int, seen int, primary key (item_id, profile));
    create table collection_items(collection_id text, item_id text);
    create table meta(k text primary key, v text);`);
  let n = 0;
  db.add = (context, title, extra = {}) => {
    n++;
    const r = db.prepare('insert into items(id, platform, context, title, text, flags, first_seen, last_seen, saved) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(extra.id || `p${n}`, extra.platform || 'web', context, title, extra.text ?? '', '{}', n, n, extra.saved ? 1 : 0);
    db.prepare('insert into items_fts(rowid, title, text) values (?, ?, ?)').run(r.lastInsertRowid, title, extra.text ?? '');
  };
  return db;
}

test('Vietnamese is told apart from French, Spanish and Portuguese accents', () => {
  assert(isVietnamese(VI, ''));
  assert(!isVietnamese(ES, 'São Paulo, à la carte, crème brûlée, você está'));
  assert(!isVietnamese(EN, ''));
});

test('web language balance trims other languages to a third, evenly across sources, and keeps them out', () => {
  const db = feed();
  for (let i = 0; i < 10; i++) db.add('Báo A', `${VI} ${i}`);
  for (let i = 0; i < 12; i++) db.add('El País', `${ES} ${i}`);
  for (let i = 0; i < 8; i++) db.add('BBC', `${EN} ${i}`);
  db.add('BBC', `${EN} saved`, { saved: true });
  db.add('Wikipedia · Hà Nội', 'Paris', { text: 'Paris is the capital of France' });
  db.add('X', ES, { platform: 'x' });
  const r = balanceWebLanguages(db, 67);
  assert.equal(r.vietnamese, 10);
  assert.equal(r.others, 21); // Wikipedia and other platforms are not counted
  const left = src => db.prepare("select count(*) n from items where context = ?").get(src).n;
  assert.equal(left('Báo A') , 10);
  assert.equal(left('El País') + left('BBC'), 4); // floor(10 * 33 / 67)
  assert(left('El País') >= 1 && left('BBC') >= 2, 'every source keeps its newest');
  assert.equal(db.prepare("select count(*) n from items where saved = 1").get().n, 1);
  assert.equal(left('Wikipedia · Hà Nội'), 1);
  assert.equal(left('X'), 1);
  assert.equal(db.prepare("select count(*) n from items where context = 'El País' and title = ?").get(`${ES} 11`).n, 1, 'newest kept');
  assert.equal(db.prepare('select count(*) n from items_fts').get().n, db.prepare('select count(*) n from items').get().n);
  assert.equal(db.prepare('select count(*) n from content_removed').get().n, r.removed);
  assert(r.admit < 1 && r.admit >= 0.25);
  assert.equal(balanceWebLanguages(db, 67).removed, 0, 'a second run changes nothing');
  assert.equal(balanceWebLanguages(db, 0).removed, 0, '0 turns it off');
});

test('the ingest gate keeps a stable share of posts', () => {
  const ids = Array.from({ length: 4000 }, (_, i) => `web:https://example.com/${i}`);
  const kept = ids.filter(id => admitsWebPost(id, 0.25)).length;
  assert(kept > 850 && kept < 1150, String(kept));
  assert.deepEqual(ids.slice(0, 50).map(id => admitsWebPost(id, 0.25)), ids.slice(0, 50).map(id => admitsWebPost(id, 0.25)));
  assert(ids.every(id => admitsWebPost(id, 1)));
});

// A stand-in for Google's reply: echoes each sentence as [translation, original].
const fake = (dict, lang = 'es', calls = []) => async (url, opts) => {
  const q = new URLSearchParams(opts.body).get('q');
  calls.push(q);
  const sentences = q.match(/[^\n.?!]+[.?!]?\s*|\n+/g) || [];
  return { ok: true, json: async () => [sentences.map(s => [dict[s.trim()] ? s.replace(s.trim(), dict[s.trim()]) : s, s]), null, lang] };
};

test('title and text come back separately from one request', async () => {
  const calls = [];
  const r = await translateFields(['Hola mundo.', 'Primera frase. Segunda frase.\n\nOtro párrafo.'], fake({ 'Hola mundo.': 'Hello world.', 'Primera frase.': 'First sentence.', 'Segunda frase.': 'Second sentence.', 'Otro párrafo.': 'Another paragraph.' }, 'es', calls));
  assert.equal(calls.length, 1);
  assert.equal(r.lang, 'es');
  assert.deepEqual(r.fields, ['Hello world.', 'First sentence. Second sentence.\n\nAnother paragraph.']);
  const empty = await translateFields(['', 'Hola mundo.'], fake({ 'Hola mundo.': 'Hello world.' }));
  assert.deepEqual(empty.fields, ['', 'Hello world.']);
});

test('English detection', () => {
  assert(looksEnglish(EN + '. It is the first of its kind in the region.'));
  assert(!looksEnglish(ES));
  assert(!looksEnglish('Le gouvernement a annoncé de nouvelles mesures pour la région'));
});

test('translator shows foreign posts in English, skips English and Vietnamese, and search finds the English', async () => {
  const db = feed();
  initTranslations(db);
  db.add('El País', 'Hola mundo.', { id: 'es1', text: 'Otro párrafo.' });
  db.add('BBC', EN, { id: 'en1' });
  db.add('Báo A', VI, { id: 'vi1' });
  db.add('Blog', 'Bonjour.', { id: 'fr-en', text: '' });
  db.add('Threads', '#PersijaDay', { id: 'tag' }); // comes back unchanged: not marked as translated
  const calls = [];
  const tr = startTranslator(db, () => {}, () => ({}), { fetchImpl: fake({ 'Hola mundo.': 'Hello world.', 'Otro párrafo.': 'Another paragraph.', 'Bonjour.': 'Hello.' }, 'es', calls), intervalMs: 0, gapMs: 0 });
  assert.equal(await tr.tick(), 2);
  assert.equal(calls.length, 3, 'English and Vietnamese posts are not sent');
  assert.equal(db.prepare("select tr_from from items where id = 'tag'").get().tr_from, null);
  const es = db.prepare("select * from items where id = 'es1'").get();
  assert.deepEqual([es.tr_from, es.tr_title, es.tr_text, es.title], ['es', 'Hello world.', 'Another paragraph.', 'Hola mundo.']);
  assert.equal(db.prepare("select count(*) n from items where tr_done = 1").get().n, 5);
  assert.equal(db.prepare("select count(*) n from items_fts where items_fts match 'paragraph'").get().n, 1);
  assert.equal(await tr.tick(), 0);
  const art = await translatedArticle(db, { id: 'es1', tr_from: 'es' }, { title: 'Hola mundo.', blocks: [{ t: 'p', text: 'Otro párrafo.' }, { t: 'img', src: 'x.jpg' }] }, fake({ 'Hola mundo.': 'Hello world.', 'Otro párrafo.': 'Another paragraph.' }));
  assert.deepEqual([art.title, art.blocks[0].text, art.blocks[1].src, art.translatedFrom], ['Hello world.', 'Another paragraph.', 'x.jpg', 'Spanish']);
});

test('translator pauses when the service refuses, leaving posts pending', async () => {
  const db = feed();
  initTranslations(db);
  db.add('El País', ES, { id: 'es1' });
  const tr = startTranslator(db, () => {}, () => ({}), { fetchImpl: async () => ({ ok: false, status: 429 }), intervalMs: 0, gapMs: 0 });
  assert.equal(await tr.tick(), 0);
  assert.equal(db.prepare("select tr_done from items where id = 'es1'").get().tr_done, 0);
});
