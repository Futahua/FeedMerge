import test from 'node:test';
import assert from 'node:assert/strict';
import { articleBlocks } from '../article.mjs';

const para = n => `<p>Paragraph ${n}: ${'Đây là nội dung bài báo khá dài để Readability nhận ra phần chính của trang. '.repeat(3)}</p>`;

test('article pages reduce to plain blocks; scripts and handlers never survive', () => {
  const html = `<!doctype html><html><head><title>Tin nóng - VnExpress</title><script>alert(1)</script></head><body>
    <nav><a href="/">Trang chủ</a><a href="/the-gioi">Thế giới</a></nav>
    <article><h1>Tin nóng</h1>${para(1)}
      <figure><img src="/img/a.jpg" width="680" height="408" alt="Ảnh" onerror="alert(2)"><figcaption>Chú thích ảnh</figcaption></figure>
      ${para(2)}<h2>Diễn biến</h2><ul><li>Ý một</li><li>Ý hai</li></ul>${para(3)}
      <p>Có <b>chữ đậm</b> và <a href="javascript:alert(3)">liên kết</a>.</p><script>alert(4)</script>${para(4)}</article>
    <footer>Bản quyền</footer></body></html>`;
  const a = articleBlocks(html, 'https://vnexpress.net/tin-nong-1.html');
  assert.ok(a);
  const types = a.blocks.map(b => b.t);
  assert.ok(types.includes('p') && types.includes('h') && types.includes('li') && types.includes('img') && types.includes('cap'));
  const img = a.blocks.find(b => b.t === 'img');
  assert.deepEqual(img, { t: 'img', src: 'https://vnexpress.net/img/a.jpg', w: 680, h: 408, alt: 'Ảnh' });
  assert.ok(a.blocks.some(b => b.text === 'Có chữ đậm và liên kết.'));
  const all = JSON.stringify(a);
  assert.doesNotMatch(all, /alert|<script|onerror|javascript:|Trang chủ|Bản quyền/);
});

test('pages without an article give nothing', () => {
  assert.equal(articleBlocks('<html><body><nav><a href="/">x</a></nav></body></html>', 'https://example.com/'), null);
});

test('author placeholders without dimensions are excluded while article photos remain', () => {
  const html = `<html><body><article><h1>Hospital report</h1><img src="https://static.thanhnien.com.vn/thanhnien.vn/image/ava_inter.png" alt="Reporter"><img src="/hospital.jpg" width="660" height="400">${para(1)}${para(2)}${para(3)}</article></body></html>`;
  const article = articleBlocks(html, 'https://thanhnien.vn/report.html');
  assert.ok(article);
  assert.deepEqual(article.blocks.filter(b => b.t === 'img').map(b => b.src), ['https://thanhnien.vn/hospital.jpg']);
});
