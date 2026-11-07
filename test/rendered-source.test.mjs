import test from 'node:test';
import assert from 'node:assert/strict';
import { appShell } from '../sources.mjs';

test('JavaScript app shells are told apart from ordinary pages', () => {
  const shell = '<!doctype html><html><head><script type="module" src="/_nuxt/entry.js"></script></head><body><div id="__nuxt"></div><script>window.__NUXT__={}</script></body></html>';
  assert.equal(appShell(shell), true);
  const page = `<html><body><div id="app">${'<p>Một đoạn văn bản bài báo đủ dài để là nội dung thật của trang.</p>'.repeat(12)}</div><script src="/a.js"></script></body></html>`;
  assert.equal(appShell(page), false);
  assert.equal(appShell('<html><body>Tiny page with no scripts</body></html>'), false);
});
