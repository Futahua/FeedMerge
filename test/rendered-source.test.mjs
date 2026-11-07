import test from 'node:test';
import assert from 'node:assert/strict';
import { appShell, discoverFeeds } from '../sources.mjs';

test('publisher RSS directories supply candidates without script or comments links', () => {
  const html = '<a href="/rss/latest.rss">Latest</a><a href="https://feeds.site.test/world.xml">World</a><a href="/comments/feed">Comments</a><script><a href="/fake.xml">Fake</a></script>';
  assert.deepEqual(discoverFeeds(html, 'https://site.test/'), ['https://site.test/rss/latest.rss', 'https://feeds.site.test/world.xml']);
});

test('JavaScript app shells are told apart from ordinary pages', () => {
  const shell = '<!doctype html><html><head><script type="module" src="/_nuxt/entry.js"></script></head><body><div id="__nuxt"></div><script>window.__NUXT__={}</script></body></html>';
  assert.equal(appShell(shell), true);
  const page = `<html><body><div id="app">${'<p>Một đoạn văn bản bài báo đủ dài để là nội dung thật của trang.</p>'.repeat(12)}</div><script src="/a.js"></script></body></html>`;
  assert.equal(appShell(page), false);
  assert.equal(appShell('<html><body>Tiny page with no scripts</body></html>'), false);
});
