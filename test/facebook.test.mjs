import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture } from '../parsers.mjs';

// Shaped like Facebook's Comet news feed: streamed Relay chunks, the story's content nested
// under comet_sections, counts under feedback, comments that must not become content.
const story = (id, extra = {}) => ({
  __typename: 'Story', id: 'S:' + id, post_id: id,
  comet_sections: {
    content: { story: {
      __typename: 'Story', id: 'S:' + id, wwwURL: `https://www.facebook.com/page/posts/${id}`,
      message: { text: `Post ${id} text` },
      actors: [{ __typename: 'User', id: '9', name: 'Ann Lee', profile_picture: { uri: 'https://scontent.xx.fbcdn.net/a.jpg' } }],
      attachments: [{ styles: { attachment: { media: { __typename: 'Photo', id: 'p' + id, photo_image: { uri: `https://scontent.xx.fbcdn.net/${id}.jpg`, width: 1080, height: 1350 } } } } }],
    } },
    context_layout: { story: { comet_sections: { metadata: [{ story: { creation_time: 1762500000 } }] } } },
    feedback: { story: { feedback_context: { feedback_target_with_context: { comet_ufi_summary_and_actions_renderer: { feedback: {
      reaction_count: { count: 1234 }, share_count: { count: 12 },
      comment_rendering_instance: { comments: { total_count: 56 } },
      top_level_comments: { nodes: [{ body: { text: 'a comment' }, message: { text: 'comment message' }, author: { name: 'Bob', profile_picture: { uri: 'https://scontent.xx.fbcdn.net/bob.jpg' } } }] },
    } } } } } },
  },
  ...extra,
});

const cap = (docs, pageUrl = 'https://www.facebook.com/') => ({
  platform: 'facebook', kind: 'json', url: 'https://www.facebook.com/api/graphql/', pageUrl, capturedAt: 1762500100000,
  text: docs.map(d => JSON.stringify(d)).join('\r\n'),
});

test('facebook feed stories become posts with media, counts and author', () => {
  const items = parseCapture(cap([
    { data: { viewer: { news_feed: { edges: [{ node: story('111') }] } } } },
    { label: 'CometNewsFeed_viewer$stream$CometNewsFeed_viewer_news_feed', data: { node: story('222', { sponsored_data: { ad_id: 'x' } }) } },
  ]));
  assert.equal(items.length, 2);
  const [a, b] = items;
  assert.equal(a.id, 'facebook:111');
  assert.equal(a.context, 'home');
  assert.equal(a.text, 'Post 111 text');
  assert.equal(a.author, 'Ann Lee');
  assert.equal(a.url, 'https://www.facebook.com/page/posts/111');
  assert.equal(a.publishedAt, 1762500000000);
  assert.deepEqual(a.media, [{ id: 'p111', type: 'image', url: 'https://scontent.xx.fbcdn.net/111.jpg', w: 1080, h: 1350 }]);
  assert.deepEqual(a.metrics, { likes: 1234, comments: 56, reposts: 12 });
  assert.equal(a.flags.avatar, 'https://scontent.xx.fbcdn.net/a.jpg');
  assert.equal(a.flags.ad, undefined);
  assert.equal(b.flags.ad, true);
});

test('a shared post takes the original content only where the sharer added none', () => {
  const s = story('333');
  const inner = s.comet_sections.content.story;
  delete inner.message;
  inner.attachments = [];
  s.attached_story = { __typename: 'Story', post_id: '444', message: { text: 'original words' },
    attachments: [{ media: { __typename: 'Video', id: 'v1', playable_url: 'https://video.xx.fbcdn.net/v.mp4', preferred_thumbnail: { image: { uri: 'https://scontent.xx.fbcdn.net/t.jpg' } }, playable_duration_in_ms: 61000 } }] };
  const [it] = parseCapture(cap([{ data: { node: s } }]));
  assert.equal(it.nativeId, '333');
  assert.equal(it.text, 'original words');
  assert.equal(it.flags.shared, true);
  assert.deepEqual(it.media, [{ id: 'v1', type: 'video', url: 'https://scontent.xx.fbcdn.net/t.jpg', video: 'https://video.xx.fbcdn.net/v.mp4', duration: 61000 }]);
});

test('comments and empty stories are not posts; page decides the context', () => {
  const empty = story('555');
  delete empty.comet_sections.content.story.message;
  empty.comet_sections.content.story.attachments = [];
  assert.equal(parseCapture(cap([{ data: { node: empty } }])).length, 0);
  assert.equal(parseCapture(cap([{ data: { node: story('666') } }], 'https://www.facebook.com/groups/feed/'))[0].context, 'groups');
  assert.equal(parseCapture(cap([{ data: { node: story('777') } }], 'https://www.facebook.com/someone/posts/777'))[0].context, 'thread');
  assert.equal(parseCapture(cap([{ data: { node: story('888') } }], 'https://www.facebook.com/someone'))[0].context, 'profile');
});

test('streamed responses with the for(;;) guard still parse', () => {
  const c = cap([{ data: { node: story('999') } }]);
  c.text = 'for (;;);' + c.text;
  assert.equal(parseCapture(c).length, 1);
});
