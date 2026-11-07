import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture } from '../parsers.mjs';

const cap = (doc, pageUrl = 'https://www.pinterest.com/') => ({
  platform: 'pinterest', kind: 'json', url: '/resource/UserHomefeedResource/get/', pageUrl, capturedAt: 1762500100000, text: JSON.stringify(doc),
});

test('home feed pins from the REST resource', () => {
  const doc = { resource_response: { data: [
    { type: 'pin', id: '111', grid_title: 'Cozy reading nook', description: 'Small corner ideas', link: 'https://blog.example.com/nook', domain: 'blog.example.com',
      created_at: 'Tue, 04 Nov 2025 10:00:00 +0000',
      images: { '236x': { url: 'https://i.pinimg.com/236x/a.jpg', width: 236, height: 354 }, orig: { url: 'https://i.pinimg.com/originals/a.jpg', width: 1000, height: 1500 } },
      pinner: { username: 'ann', full_name: 'Ann', image_medium_url: 'https://i.pinimg.com/75x75/ann.jpg' },
      aggregated_pin_data: { aggregated_stats: { saves: 4200 } }, reaction_counts: { 1: 12 }, comment_count: 3,
      board: { type: 'board', id: '999', images: { '170x': [] } } },
    { type: 'pin', id: '222', title: 'Promo', is_promoted: true, images: { orig: { url: 'https://i.pinimg.com/originals/b.jpg', width: 800, height: 800 } }, pinner: { username: 'brand' },
      videos: { video_list: { V_HLSV4: { url: 'https://v1.pinimg.com/x.m3u8' }, V_720P: { url: 'https://v1.pinimg.com/x.mp4', width: 720, height: 1280, duration: 15000, thumbnail: 'https://i.pinimg.com/t.jpg' } } } },
    { type: 'story', id: 'abc' },
  ] } };
  const [a, b] = parseCapture(cap(doc));
  assert.equal(a.id, 'pinterest:111');
  assert.equal(a.context, 'home');
  assert.equal(a.title, 'Cozy reading nook');
  assert.equal(a.text, 'Small corner ideas');
  assert.equal(a.author, 'ann');
  assert.equal(a.url, 'https://www.pinterest.com/pin/111/');
  assert.deepEqual(a.media, [{ type: 'image', url: 'https://i.pinimg.com/originals/a.jpg', w: 1000, h: 1500 }]);
  assert.deepEqual(a.metrics, { saves: 4200, likes: 12, comments: 3 });
  assert.equal(a.flags.domain, 'blog.example.com');
  assert.equal(a.publishedAt, Date.parse('2025-11-04T10:00:00Z'));
  assert.equal(b.flags.ad, true);
  assert.equal(b.media[0].type, 'video');
  assert.equal(b.media[0].video, 'https://v1.pinimg.com/x.mp4');
});

test('graphql pins, idea-pin pages, and page contexts', () => {
  const doc = { data: { v3HomefeedQuery: { edges: [{ node: { __typename: 'Pin', entityId: '333', title: 'Idea',
    imageSpec_orig: { url: 'https://i.pinimg.com/originals/c.jpg', width: 600, height: 900 },
    nativeCreator: { username: 'cara', fullName: 'Cara' },
    storyPinData: { pages: [{ blocks: [{ image: { images: { orig: { url: 'https://i.pinimg.com/originals/p1.jpg', width: 600, height: 900 } } } }] },
      { blocks: [{ image: { images: { orig: { url: 'https://i.pinimg.com/originals/p2.jpg', width: 600, height: 900 } } } }] }] } } }] } } };
  const [p] = parseCapture(cap(doc));
  assert.equal(p.nativeId, '333');
  assert.equal(p.authorName, 'Cara');
  assert.deepEqual(p.media.map(m => m.url), ['https://i.pinimg.com/originals/p1.jpg', 'https://i.pinimg.com/originals/p2.jpg']);
  assert.equal(parseCapture(cap(doc, 'https://www.pinterest.com/pin/5/'))[0].context, 'related');
  assert.equal(parseCapture(cap(doc, 'https://www.pinterest.com/search/pins/?q=x'))[0].context, 'search');
  assert.equal(parseCapture(cap(doc, 'https://www.pinterest.com/cara/boards/'))[0].context, 'profile');
});
