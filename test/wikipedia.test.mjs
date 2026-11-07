import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startWikipedia } from '../wikipedia.mjs';
import { parseCapture } from '../parsers.mjs';

const page = (title, extra = {}) => ({ ns: 0, title, index: 1, fullurl: `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}`, description: 'a thing', extract: `${title} is described here at enough length to be a real article intro for the card. `.repeat(2), thumbnail: { source: `https://upload.wikimedia.org/${title}.jpg` }, ...extra });

test('related pages from feed subjects and random quality articles, never repeated', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table items(id text, platform text, title text, text text, flags text, last_seen int, saved int default 0, seen_count int default 1);
    create table item_labels(item_id text, label_id int, decided int); create table labels(id int, layer text, name text);
    create table meta(k text primary key, v text);
    insert into items values('x:1','x','','Mình vừa thêm tính năng Avata vào trong Revit hôm nay', '{}', ${Date.now()}, 0, 3);`);
  const urls = [];
  globalThis.fetch = async u => {
    const q = new URL(u).searchParams; urls.push(String(u));
    const json = b => ({ ok: true, json: async () => b });
    if (q.get('list') === 'search') return json({ query: { search: [{ title: 'Autodesk Revit' }] } });
    if (q.get('list') === 'categorymembers') return json({ query: { categorymembers: [{ title: 'M-theory' }] } });
    if (q.get('generator') === 'search') return json({ query: { pages: [page('Archicad'), page('Short', { extract: 'tiny' })] } });
    if (q.get('titles')) return json({ query: { pages: [page(q.get('titles'))] } });
    return json({});
  };
  const ingested = [];
  const ai = { active: () => true, ask: async () => '{"subjects":[{"name":"Revit","lang":"en"}]}' };
  const w = startWikipedia(db, cap => { ingested.push(cap); return { added: 1, parsed: 1 }; }, () => {}, () => ({ wikipedia: { contact: 'me@example.org' } }), ai);
  await w.run();
  const forYou = ingested.find(c => c.pageUrl === 'source:Wikipedia · for you');
  const items = parseCapture({ ...forYou, text: forYou.payload });
  assert.equal(items[0].title, 'Autodesk Revit');
  assert.match(items[0].text, /In your feed: Revit/);
  assert.equal(items[0].media[0].url, 'https://upload.wikimedia.org/Autodesk Revit.jpg');
  assert.ok(ingested.find(c => c.pageUrl === 'source:Wikipedia · random'));
  assert.ok(urls.every(u => u.startsWith('https://') && /wikipedia\.org\/w\/api\.php/.test(u)));
  // A second run does not show the same article again: it moves on to a neighbour.
  ingested.length = 0;
  await w.run();
  const again = parseCapture({ ...ingested.find(c => c.pageUrl === 'source:Wikipedia · for you'), text: ingested.find(c => c.pageUrl === 'source:Wikipedia · for you').payload });
  assert.equal(again[0].title, 'Archicad');
  // Two months on, the first page may be shown again.
  db.prepare("update wiki_seen set shown_at = shown_at - ? where title = 'Autodesk Revit'").run(61 * 864e5);
  ingested.length = 0;
  await w.run();
  const later = ingested.find(c => c.pageUrl === 'source:Wikipedia · for you');
  assert.equal(parseCapture({ ...later, text: later.payload })[0].title, 'Autodesk Revit');
});
