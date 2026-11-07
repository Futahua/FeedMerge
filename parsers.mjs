// Turns captured platform data into feed items. Pure functions: the server can re-run
// them over every stored capture (POST /api/reparse) whenever a parser improves.

import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';

export function parseCapture(cap) {
  const fn = PARSERS[cap.platform];
  if (!fn) return [];
  const now = cap.capturedAt || Date.now();
  const items = [];
  if (cap.platform === 'web' && cap.kind === 'feed') parseFeedText(cap.text, cap, items);
  else {
    const docs = cap.kind === 'dom' || cap.kind === 'links' ? [safeJson(cap.text)] : parseJsonish(cap.text);
    for (const doc of docs) if (doc) fn(doc, cap, now, items);
  }
  for (const it of items) {
    it.platform = cap.platform;
    it.id = `${cap.platform}:${it.nativeId}`;
    it.context = it.context || contextFromPage(cap.platform, cap.pageUrl);
  }
  return items.filter(it => it.nativeId);
}

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

// Some endpoints prefix "for (;;);" or stream several JSON objects separated by newlines.
function parseJsonish(text) {
  if (typeof text !== 'string') return [];
  const t = text.replace(/^\s*for\s*\(;;\);/, '');
  const one = safeJson(t);
  if (one !== null) return [one];
  return t.split(/\r?\n(?=\s*[{[])/).map(safeJson).filter(Boolean);
}

// Iterative walk; visit() returns 'skip' to stop descending into that node.
function walk(root, visit) {
  const stack = [root];
  let guard = 0;
  while (stack.length && guard++ < 2_000_000) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (visit(node) === 'skip') continue;
    const vals = Array.isArray(node) ? node : Object.values(node);
    for (let i = vals.length - 1; i >= 0; i--) {
      const v = vals[i];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
}

const txt = t => (t == null ? '' : typeof t === 'string' ? t : t.simpleText ?? t.content ?? (Array.isArray(t.runs) ? t.runs.map(r => r.text).join('') : ''));
const num = v => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && String(v ?? '') !== '' ? n : undefined; };
const clean = o => { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === '') delete o[k]; return o; };

// "3 days ago", "Streamed 2 weeks ago", "10d ago", "5mo ago"
function relativeTime(s, now) {
  const m = /(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|mo|[smhdwy])\b(?:\s*ago)?/i.exec(s || '');
  if (!m || !/ago/i.test(s)) return null;
  const u = m[2].toLowerCase();
  const unit = u === 'mo' || u.startsWith('month') ? 2592e6 : { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, y: 31536e6 }[u[0]];
  return now - Number(m[1]) * unit;
}

// "1,234 views", "284K", "1.2M views"
const count = v => {
  const m = /([\d.,]+)\s*([KMB])?/i.exec(String(v ?? ''));
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1);
  return Number.isFinite(n) ? Math.round(n) : undefined;
};

function contextFromPage(platform, pageUrl) {
  let u;
  try { u = new URL(pageUrl); } catch { return 'other'; }
  const p = u.pathname.replace(/\/+$/, '') || '/';
  switch (platform) {
    case 'youtube':
      if (p === '/') return 'home';
      if (p.startsWith('/feed/subscriptions')) return 'subscriptions';
      if (p.startsWith('/watch')) return 'up-next';
      if (p.startsWith('/shorts')) return 'shorts';
      if (p.startsWith('/results')) return 'search';
      if (p.startsWith('/@') || p.startsWith('/channel')) return 'channel';
      return p.split('/')[1] || 'other';
    case 'reddit':
      if (p === '/' || p === '/best' || p === '/hot' || p === '/new' || p === '/top') return 'home';
      if (p.startsWith('/r/popular')) return 'popular';
      if (p.startsWith('/r/all')) return 'all';
      if (/^\/r\/[^/]+\/comments\//.test(p)) return 'thread';
      if (p.startsWith('/r/')) return 'subreddit';
      if (p.startsWith('/user/') || p.startsWith('/u/')) return 'profile';
      if (p.startsWith('/search')) return 'search';
      return 'other';
    case 'instagram':
      if (p === '/') return 'home';
      if (p.startsWith('/reels') || p.startsWith('/reel/')) return 'reels';
      if (p.startsWith('/explore')) return 'explore';
      if (p.startsWith('/p/')) return 'post';
      return 'profile';
    case 'facebook':
      if (p === '/' || p === '/home.php') return 'home';
      if (p.startsWith('/groups/feed')) return 'groups';
      if (/^\/groups\/[^/]+\/(posts|permalink)\//.test(p)) return 'thread';
      if (p.startsWith('/groups/')) return 'group';
      if (p.startsWith('/watch')) return 'watch';
      if (p.startsWith('/reel')) return 'reels';
      if (p.startsWith('/search')) return 'search';
      if (p.startsWith('/marketplace') || p.startsWith('/notifications') || p.startsWith('/messages')) return 'other';
      if (/^\/(permalink\.php|story\.php|photo|[^/]+\/(posts|videos|photos)\/)/.test(p)) return 'thread';
      return 'profile';
    case 'threads':
      if (p === '/' || p === '/for_you') return 'for-you';
      if (p.startsWith('/following')) return 'following';
      if (p.startsWith('/search')) return 'search';
      return p.startsWith('/@') ? 'profile' : 'other';
    case 'tiktok':
      if (p === '/' || p === '/foryou' || p === '/en') return 'for-you';
      if (p.startsWith('/following')) return 'following';
      if (p.startsWith('/explore')) return 'explore';
      if (p.startsWith('/search')) return 'search';
      return p.startsWith('/@') ? 'profile' : 'other';
    case 'x':
      if (p === '/home') return 'for-you';
      return 'other';
    case 'bluesky':
      return p === '/' ? 'home' : 'other';
  }
  return 'other';
}

// ---------- X ----------
const X_OPS = { HomeTimeline: 'for-you', HomeLatestTimeline: 'following', TweetDetail: 'thread', SearchTimeline: 'search', UserTweets: 'profile', ListLatestTweetsTimeline: 'list', Bookmarks: 'bookmarks' };

function xUser(r) {
  const u = r?.core?.user_results?.result;
  const avatar = (u?.avatar?.image_url || u?.legacy?.profile_image_url_https || '').replace('_normal.', '_bigger.');
  return { screen: u?.core?.screen_name || u?.legacy?.screen_name, name: u?.core?.name || u?.legacy?.name, avatar, verified: !!(u?.is_blue_verified || u?.legacy?.verified) };
}

function xMedia(m) {
  const w = m.original_info?.width, h = m.original_info?.height;
  if (m.type === 'photo') return { type: 'image', url: m.media_url_https, w, h };
  const mp4 = (m.video_info?.variants || []).filter(v => v.content_type === 'video/mp4').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const pick = mp4.find(v => (v.bitrate || 0) <= 2_500_000) || mp4.at(-1);
  return { type: m.type === 'animated_gif' ? 'gif' : 'video', url: m.media_url_https, video: pick?.url, w, h, duration: m.video_info?.duration_millis };
}

function xTweet(r) {
  if (r?.__typename === 'TweetWithVisibilityResults') r = r.tweet;
  if (!r?.legacy || !r.rest_id) return null;
  const L = r.legacy;
  const { screen, name, avatar, verified } = xUser(r);
  const media = (L.extended_entities?.media || L.entities?.media || []).map(xMedia);
  return {
    nativeId: r.rest_id,
    author: screen,
    authorName: name,
    text: r.note_tweet?.note_tweet_results?.result?.text || L.full_text || '',
    url: `https://x.com/${screen || 'i'}/status/${r.rest_id}`,
    media,
    publishedAt: Date.parse(L.created_at) || null,
    metrics: clean({ likes: L.favorite_count, reposts: L.retweet_count, replies: L.reply_count, quotes: L.quote_count, views: num(r.views?.count) }),
    flags: clean({ avatar, verified: verified || undefined }),
  };
}

function parseX(doc, cap, now, out) {
  const op = /\/graphql\/[^/]+\/(\w+)/.exec(cap.url || '')?.[1];
  const context = X_OPS[op] || (op ? op.toLowerCase() : undefined);
  const promoted = new Set();
  walk(doc, n => { if (n.promotedMetadata && n.tweet_results?.result) { const t = n.tweet_results.result; promoted.add(t.rest_id || t.tweet?.rest_id); } });
  walk(doc, n => {
    if (n.__typename !== 'Tweet' && n.__typename !== 'TweetWithVisibilityResults') return;
    const outer = xTweet(n);
    if (!outer) return 'skip';
    const rtInner = (n.tweet || n).legacy?.retweeted_status_result?.result;
    let item = outer;
    if (rtInner) {
      const inner = xTweet(rtInner);
      if (inner) { inner.flags.repostedBy = outer.author; item = inner; }
    }
    const q = xTweet((n.tweet || n).quoted_status_result?.result);
    if (q) item.flags.quote = { author: q.author, name: q.authorName, avatar: q.flags.avatar, text: q.text.slice(0, 500), url: q.url, media: q.media.slice(0, 1) };
    if (promoted.has(outer.nativeId)) item.flags.ad = true;
    item.context = context;
    out.push(item);
    return 'skip';
  });
}

// ---------- YouTube ----------
function ytThumb(n) {
  let best = null;
  walk(n, x => { if (Array.isArray(x.thumbnails) && x.thumbnails.length) { best = x.thumbnails.at(-1).url; return 'skip'; } if (Array.isArray(x.sources) && x.sources[0]?.url) { best = x.sources.at(-1).url; return 'skip'; } });
  return best;
}

function ytBadge(n) {
  let t;
  walk(n, x => { const s = x.thumbnailBadgeViewModel?.text; if (typeof s === 'string' && /^\d+(:\d+)+$/.test(s)) { t = s; return 'skip'; } });
  return t;
}

function parseYouTube(doc, cap, now, out) {
  walk(doc, n => {
    if (n.adSlotRenderer || n.promotedSparklesWebRenderer || n.displayAdRenderer) return 'skip';
    const v = n.videoRenderer || n.gridVideoRenderer || n.compactVideoRenderer;
    if (v?.videoId) {
      const ago = txt(v.publishedTimeText);
      out.push({
        nativeId: v.videoId,
        author: txt(v.ownerText || v.shortBylineText || v.longBylineText),
        title: txt(v.title),
        text: txt(v.descriptionSnippet) || (v.detailedMetadataSnippets?.[0] ? txt(v.detailedMetadataSnippets[0].snippetText) : ''),
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        media: [{ type: 'video', url: ytThumb(v.thumbnail) }].filter(m => m.url),
        publishedAt: relativeTime(ago, now),
        metrics: clean({ views: count(txt(v.viewCountText)), duration: txt(v.lengthText) || undefined, ago: ago || undefined }),
        flags: clean({ avatar: v.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails?.[0]?.url }),
      });
      return 'skip';
    }
    const lk = n.lockupViewModel;
    if (lk && (lk.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' || (!lk.contentType && /^[\w-]{11}$/.test(lk.contentId || '')))) {
      const meta = lk.metadata?.lockupMetadataViewModel;
      const parts = (meta?.metadata?.contentMetadataViewModel?.metadataRows || []).map(r => (r.metadataParts || []).map(p => ({ text: txt(p.text), label: p.accessibilityLabel || '' })));
      const rows = parts.map(r => r.map(p => p.text));
      const flat = parts.flat();
      const agoPart = flat.find(p => /ago/i.test(p.label) || /ago/i.test(p.text));
      const ago = agoPart ? agoPart.label || agoPart.text : '';
      const viewsPart = flat.find(p => /view/i.test(p.label) || /view/i.test(p.text));
      out.push({
        nativeId: lk.contentId,
        author: rows[0]?.[0] || '',
        title: txt(meta?.title),
        url: `https://www.youtube.com/watch?v=${lk.contentId}`,
        media: [{ type: 'video', url: ytThumb(lk.contentImage) }].filter(m => m.url),
        publishedAt: relativeTime(ago, now),
        metrics: clean({ views: viewsPart ? count(viewsPart.text) : undefined, ago: agoPart?.text || undefined, duration: ytBadge(lk.contentImage) }),
        flags: clean({ avatar: meta?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources?.[0]?.url }),
      });
      return 'skip';
    }
    const sh = n.shortsLockupViewModel;
    if (sh) {
      const id = sh.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || /([\w-]{11})$/.exec(sh.entityId || '')?.[1];
      if (id) out.push({
        nativeId: id,
        title: txt(sh.overlayMetadata?.primaryText),
        url: `https://www.youtube.com/shorts/${id}`,
        media: [{ type: 'video', url: ytThumb(sh.thumbnailViewModel || sh.thumbnail) }].filter(m => m.url),
        metrics: clean({ views: count(txt(sh.overlayMetadata?.secondaryText)) }),
        flags: { short: true },
        context: 'shorts',
      });
      return 'skip';
    }
    const reel = n.reelItemRenderer;
    if (reel?.videoId) {
      out.push({ nativeId: reel.videoId, title: txt(reel.headline), url: `https://www.youtube.com/shorts/${reel.videoId}`, media: [{ type: 'video', url: ytThumb(reel.thumbnail) }].filter(m => m.url), metrics: clean({ views: count(txt(reel.viewCountText)) }), flags: { short: true }, context: 'shorts' });
      return 'skip';
    }
  });
}

// ---------- TikTok ----------
const TT_CTX = [[/recommend\/item_list/, 'for-you'], [/following\/item_list/, 'following'], [/post\/item_list/, 'profile'], [/search\//, 'search'], [/explore\/item_list/, 'explore'], [/related\/item_list/, 'related']];

function parseTikTok(doc, cap, now, out) {
  const context = TT_CTX.find(([re]) => re.test(cap.url || ''))?.[1];
  walk(doc, n => {
    if (typeof n.id !== 'string' || !/^\d{8,}$/.test(n.id) || typeof n.desc !== 'string' || !n.author?.uniqueId || !n.createTime) return;
    const s = n.statsV2 || n.stats || {};
    out.push({
      nativeId: n.id,
      author: n.author.uniqueId,
      authorName: n.author.nickname,
      text: n.desc,
      url: `https://www.tiktok.com/@${n.author.uniqueId}/video/${n.id}`,
      media: n.imagePost?.images?.length
        ? n.imagePost.images.slice(0, 10).map(i => ({ type: 'image', url: i.imageURL?.urlList?.[0], w: i.imageWidth, h: i.imageHeight })).filter(m => m.url)
        : [{ type: 'video', url: n.video?.cover || n.video?.originCover, w: n.video?.width, h: n.video?.height, duration: n.video?.duration ? n.video.duration * 1000 : undefined }].filter(m => m.url),
      publishedAt: Number(n.createTime) * 1000,
      metrics: clean({ views: num(s.playCount), likes: num(s.diggCount), comments: num(s.commentCount), shares: num(s.shareCount), saves: num(s.collectCount) }),
      flags: clean({ ad: n.isAd || undefined, avatar: n.author.avatarThumb || n.author.avatarMedium, music: n.music?.title ? `${n.music.title}${n.music.authorName ? ' · ' + n.music.authorName : ''}` : undefined }),
      context,
    });
    return 'skip';
  });
}

// ---------- Instagram / Threads (same Meta post shape) ----------
function metaPosts(doc, out, makeUrl) {
  // Feed ads arrive as a wrapper ({ ad_id, items: [post] }) around an ordinary-looking post.
  const adCodes = new Set();
  walk(doc, n => {
    if (typeof n.ad_id !== 'string' || !n.ad_id) return;
    walk(n, x => { if (typeof x.code === 'string' && typeof x.taken_at === 'number') adCodes.add(x.code); });
    return 'skip';
  });
  walk(doc, n => {
    if (typeof n.code !== 'string' || typeof n.taken_at !== 'number' || !n.user?.username) return;
    const parts = (n.carousel_media?.length ? n.carousel_media : [n]).slice(0, 10);
    const media = parts.map(p => {
      const img = p.image_versions2?.candidates?.[0]?.url;
      const vid = p.video_versions?.[0]?.url;
      return img ? clean({ type: vid ? 'video' : 'image', url: img, video: vid, w: p.original_width, h: p.original_height, duration: p.video_duration ? Math.round(p.video_duration * 1000) : undefined }) : null;
    }).filter(Boolean);
    out.push({
      nativeId: n.code,
      author: n.user.username,
      authorName: n.user.full_name,
      text: n.caption?.text || '',
      url: makeUrl(n),
      media,
      publishedAt: n.taken_at * 1000,
      metrics: clean({ likes: n.like_count, comments: n.comment_count, views: n.play_count ?? n.view_count, reposts: n.text_post_app_info?.repost_count }),
      flags: clean({
        ad: n.ad_id || n.is_ad || adCodes.has(n.code) || undefined,
        avatar: n.user.profile_pic_url,
        verified: n.user.is_verified || undefined,
        reel: n.product_type === 'clips' || undefined,
        music: n.clips_metadata?.music_info?.music_asset_info?.title || n.clips_metadata?.original_sound_info?.original_audio_title || undefined,
      }),
    });
    return 'skip';
  });
}

const parseInstagram = (doc, cap, now, out) => metaPosts(doc, out, n => `https://www.instagram.com/${n.product_type === 'clips' ? 'reel' : 'p'}/${n.code}/`);
const parseThreads = (doc, cap, now, out) => metaPosts(doc, out, n => `https://www.threads.com/@${n.user.username}/post/${n.code}`);

// ---------- Facebook ----------
// Feed stories arrive as Relay GraphQL (streamed, newline-separated). The layout around a
// story changes often, so fields are found by their own names anywhere inside the story
// rather than by fixed paths. A shared post's original (attached_story) gives text and
// media only when the sharer added none; comments under `feedback` never count as content.
function fbFind(root, get, skip = FB_OWN) {
  const stack = [root];
  let guard = 0;
  while (stack.length && guard++ < 200_000) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    const v = Array.isArray(n) ? undefined : get(n);
    if (v !== undefined && v !== null && v !== '') return v;
    const keys = Array.isArray(n) ? n.keys() : Object.keys(n);
    const vals = [];
    for (const k of keys) if (!(typeof k === 'string' && skip.has(k)) && n[k] && typeof n[k] === 'object') vals.push(n[k]);
    for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
  }
}
const FB_OWN = new Set(['attached_story', 'feedback', 'comet_ufi_summary_and_actions_renderer', 'top_level_comments', 'comment_list_renderer']);
const FB_CONTENT = new Set(['feedback', 'comet_ufi_summary_and_actions_renderer', 'top_level_comments', 'comment_list_renderer', 'actors', 'actor_photo', 'owning_profile']);
const FB_ALL = new Set();

function fbMedia(story) {
  const seen = new Set(), out = [];
  const add = m => { if (m?.url && !seen.has(m.id || m.url) && out.length < 10) { seen.add(m.id || m.url); out.push(clean(m)); } };
  fbFind(story, n => {
    const t = n.__typename;
    if (t === 'Video' || n.playable_url || n.browser_native_hd_url) {
      const thumb = n.preferred_thumbnail?.image?.uri || n.thumbnailImage?.uri || n.image?.uri || n.first_frame_thumbnail;
      const video = n.browser_native_hd_url || n.playable_url_quality_hd || n.browser_native_sd_url || n.playable_url;
      if (thumb || video) add({ id: n.id, type: 'video', url: thumb, video, w: n.width || n.original_width, h: n.height || n.original_height, duration: n.playable_duration_in_ms || (n.length_in_second ? n.length_in_second * 1000 : undefined) });
      return;
    }
    // Photos; carousel cards (ads and multi-shares) carry GenericAttachmentMedia images;
    // link shares carry a preview image (not the advertiser's logo).
    const im = n.photo_image || n.viewer_image || (t === 'Photo' || t === 'GenericAttachmentMedia' || t === 'DynamicFeedAdAttachmentMedia' ? n.image : undefined)
      || n.flexible_height_share_image || n.large_share_image;
    if (im?.uri) add({ id: n.id, type: 'image', url: im.uri, w: im.width, h: im.height });
  }, FB_CONTENT);
  return out;
}

function parseFacebook(doc, cap, now, out) {
  // Ads are marked in disguised ways (scrambled labels, misspelt type names), but always
  // keep a real ad id or a SPONSORED category somewhere in the feed edge around the story.
  const AD = /"ad_id":"\d|"cat":"SPONSORED"|\\?"is_sponsored\\?":(1|true)|"category":"SPONSORED"/;
  const adPosts = new Set();
  walk(doc, n => {
    const st = n.node?.__typename === 'Story' ? n.node : null;
    if (st && typeof st.post_id === 'string' && AD.test(JSON.stringify(n))) adPosts.add(st.post_id);
  });
  walk(doc, n => {
    if (n.__typename !== 'Story' || typeof n.post_id !== 'string' || !/^\d+$/.test(n.post_id)) return;
    const shared = n.attached_story || fbFind(n, x => x.attached_story, FB_ALL);
    let text = fbFind(n, x => typeof x.message?.text === 'string' ? x.message.text : undefined);
    let media = fbMedia({ ...n, attached_story: undefined });
    if (shared && !media.length) media = fbMedia(shared);
    if (shared && !text) text = fbFind(shared, x => typeof x.message?.text === 'string' ? x.message.text : undefined);
    const actor = fbFind(n, x => Array.isArray(x.actors) && x.actors[0]?.name ? x.actors[0] : undefined) || {};
    const avatar = fbFind(n, x => Array.isArray(x.actors) && x.actors[0]?.profile_picture?.uri ? x.actors[0].profile_picture.uri : undefined)
      || fbFind(n, x => x.profile_picture?.uri);
    if (!text && !media.length) return 'skip';
    const time = fbFind(n, x => typeof x.creation_time === 'number' ? x.creation_time : undefined);
    const url = fbFind(n, x => typeof x.wwwURL === 'string' ? x.wwwURL : undefined)
      || fbFind(n, x => typeof x.permalink_url === 'string' ? x.permalink_url : undefined)
      || `https://www.facebook.com/${n.post_id}`;
    const linkAtt = fbFind(n, x => typeof x.external_url === 'string' ? x : undefined, FB_CONTENT);
    const reactions = fbFind(n, x => num(x.reaction_count?.count) ?? num(x.reactors?.count), FB_ALL);
    const comments = fbFind(n, x => num(x.comment_rendering_instance?.comments?.total_count) ?? num(x.comments?.total_count) ?? num(x.total_comment_count), FB_ALL);
    const shares = fbFind(n, x => num(x.share_count?.count) ?? num(x.reshares?.count), FB_ALL);
    const views = fbFind(n, x => num(x.video_view_count) ?? num(x.play_count), FB_ALL);
    const ad = adPosts.has(n.post_id) || AD.test(JSON.stringify({ ...n, attached_story: undefined }));
    out.push({
      nativeId: n.post_id,
      author: actor.name,
      authorName: actor.name,
      text: text || '',
      url,
      media,
      publishedAt: time ? time * 1000 : undefined,
      metrics: clean({ likes: reactions, comments, reposts: shares, views }),
      flags: clean({
        ad: ad || undefined,
        avatar,
        shared: shared ? true : undefined,
        reel: /\/reel\//.test(url) || undefined,
        link: linkAtt?.external_url,
        linkTitle: linkAtt?.title_with_entities?.text || linkAtt?.title?.text || undefined,
      }),
    });
    return 'skip';
  });
}

// ---------- Bluesky ----------
const BSKY_CTX = { getTimeline: 'following', getFeed: 'feed', getListFeed: 'list', getAuthorFeed: 'profile', getPostThread: 'thread', searchPosts: 'search' };

function parseBluesky(doc, cap, now, out) {
  const context = BSKY_CTX[/app\.bsky\.feed\.(\w+)/.exec(cap.url || '')?.[1]];
  walk(doc, n => {
    if (typeof n.uri !== 'string' || !n.uri.includes('/app.bsky.feed.post/') || typeof n.record?.text !== 'string' || !n.author?.handle) return;
    const rkey = n.uri.split('/').pop();
    const e = n.embed || {};
    const imgs = e.images || e.media?.images || [];
    const media = imgs.map(i => clean({ type: 'image', url: i.fullsize || i.thumb, w: i.aspectRatio?.width, h: i.aspectRatio?.height }))
      .concat(e.external?.thumb ? [{ type: 'link', url: e.external.thumb }] : [])
      .concat(e.thumbnail ? [clean({ type: 'video', url: e.thumbnail, w: e.aspectRatio?.width, h: e.aspectRatio?.height })] : []);
    out.push({
      nativeId: n.uri.replace('at://', ''),
      author: n.author.handle,
      authorName: n.author.displayName,
      text: n.record.text,
      url: `https://bsky.app/profile/${n.author.handle}/post/${rkey}`,
      media,
      publishedAt: Date.parse(n.record.createdAt || n.indexedAt) || null,
      metrics: clean({ likes: n.likeCount, reposts: n.repostCount, replies: n.replyCount, quotes: n.quoteCount }),
      flags: clean({ link: e.external?.uri, linkTitle: e.external?.title, avatar: n.author.avatar }),
      context,
    });
    return 'skip';
  });
}

// ---------- Reddit (DOM records from the extension) ----------
function parseReddit(doc, cap, now, out) {
  for (const p of Array.isArray(doc) ? doc : []) {
    if (!p?.id) continue;
    out.push({
      nativeId: p.id,
      author: p.author,
      authorName: p.subreddit,
      title: p.title,
      text: p.body || '',
      url: p.permalink ? new URL(p.permalink, 'https://www.reddit.com').href : undefined,
      media: p.images?.length ? p.images.map(u => ({ type: 'image', url: u })) : p.thumb ? [{ type: p.postType === 'video' ? 'video' : 'image', url: p.thumb }] : [],
      publishedAt: Date.parse(p.created) || (Number(p.created) > 1e12 ? Number(p.created) : null),
      metrics: clean({ score: num(p.score), comments: num(p.comments) }),
      flags: clean({ ad: p.promoted || undefined, link: p.href && !/reddit\.com|redd\.it/.test(p.href) ? p.href : undefined, postType: p.postType, avatar: p.icon }),
    });
  }
}

// ---------- Web sources (RSS / Atom / RDF / JSON Feed, and watched pages) ----------
const xml = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', processEntities: true, htmlEntities: true,
  isArray: name => ['item', 'entry', 'link', 'category', 'media:content', 'media:thumbnail', 'enclosure', 'author'].includes(name),
});
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeHtml = s => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => { try { return e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m; } catch { return m; } });
const tx = v => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v));
const plain = html => decodeHtml(String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
const firstImg = html => /<img[^>]+src=["']([^"']+)["']/i.exec(String(html || ''))?.[1];
const normLink = u => { try { const x = new URL(u); for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|cmpid)/i.test(k)) x.searchParams.delete(k); x.hash = ''; return x.href; } catch { return u; } };
const stableId = s => createHash('sha1').update(s).digest('hex').slice(0, 16);

function parseWeb(doc, cap, now, out) {
  const source = String(cap.pageUrl || '').replace(/^source:/, '') || 'web';
  if (cap.kind === 'links') {
    for (const l of Array.isArray(doc) ? doc : []) out.push({ nativeId: stableId(normLink(l.url)), author: source, title: l.title, text: '', url: l.url, media: [], publishedAt: null, metrics: {}, flags: {}, context: source });
    return;
  }
}

function parseFeedText(text, cap, out) {
  const source = String(cap.pageUrl || '').replace(/^source:/, '') || 'web';
  const push = (e) => {
    const link = e.link;
    if (!link && !e.guid && !e.title) return;
    const title = e.title ? plain(e.title).slice(0, 400) : '';
    let body = plain(e.body);
    // Aggregators (Google News, etc.) often repeat the headline as the whole description.
    const head = title.replace(/\s+-\s+[^-]+$/, '').slice(0, 60);
    if (head && body.startsWith(head) && body.length < title.length + 80) body = '';
    out.push({
      nativeId: stableId(normLink(link || '') || e.guid || e.title),
      author: e.author || source,
      authorName: source,
      title,
      text: body.slice(0, 4000),
      url: link,
      media: e.image ? [{ type: 'image', url: e.image }] : [],
      publishedAt: Date.parse(e.date) || null,
      metrics: {},
      flags: {},
      context: source,
    });
  };
  if (/^\s*\{/.test(text)) {
    const j = JSON.parse(text);
    for (const i of j.items || []) push({ link: i.url || i.external_url, guid: i.id, title: i.title, body: i.content_text || i.content_html || i.summary, date: i.date_published || i.date_modified, author: i.authors?.[0]?.name || i.author?.name, image: i.image || i.banner_image });
    return;
  }
  const d = xml.parse(text);
  const channel = d.rss?.channel || d['rdf:RDF'];
  const items = channel?.item || d['rdf:RDF']?.item || [];
  for (const i of items) {
    const media = i['media:content']?.find(m => /image/.test(m['@type'] || m['@medium'] || '') || /\.(jpe?g|png|webp|gif)/i.test(m['@url'] || ''))?.['@url'] || i['media:thumbnail']?.[0]?.['@url'] || i['media:group']?.['media:thumbnail']?.[0]?.['@url'];
    const enc = i.enclosure?.find(x => /image/.test(x['@type'] || ''))?.['@url'];
    const body = tx(i['content:encoded']) || tx(i.description);
    const link = tx(i.link?.[0]) || i.link?.[0]?.['@href'];
    push({ link, guid: tx(i.guid), title: tx(i.title), body, date: tx(i.pubDate) || tx(i['dc:date']), author: tx(i.source) || tx(i['dc:creator']) || tx(i.author?.[0]), image: media || enc || firstImg(body) });
  }
  for (const e of d.feed?.entry || []) {
    const links = e.link || [];
    const link = (links.find(l => !l['@rel'] || l['@rel'] === 'alternate') || links[0])?.['@href'];
    const group = e['media:group'] || {};
    const body = tx(e.content) || tx(e.summary) || tx(group['media:description']);
    push({ link, guid: tx(e.id), title: tx(e.title), body, date: tx(e.published) || tx(e.updated), author: tx(e.author?.[0]?.name), image: group['media:thumbnail']?.[0]?.['@url'] || e['media:thumbnail']?.[0]?.['@url'] || firstImg(body) });
  }
}

const PARSERS = { web: parseWeb, x: parseX, youtube: parseYouTube, tiktok: parseTikTok, facebook: parseFacebook, instagram: parseInstagram, threads: parseThreads, bluesky: parseBluesky, reddit: parseReddit };
