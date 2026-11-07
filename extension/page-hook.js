// Runs inside the page so it can see the feed data the site itself downloads.
// It only copies responses from feed endpoints; it never changes requests or the page.
(() => {
  if (window.__feedmergeHooked) return;
  window.__feedmergeHooked = true;

  const h = location.hostname;
  const platform =
    h === 'x.com' || h === 'twitter.com' ? 'x' :
    h === 'www.youtube.com' ? 'youtube' :
    h === 'www.tiktok.com' ? 'tiktok' :
    h === 'www.facebook.com' || h === 'web.facebook.com' ? 'facebook' :
    h === 'www.instagram.com' ? 'instagram' :
    /(^|\.)pinterest\.com$/.test(h) ? 'pinterest' :
    /^www\.threads\.(com|net)$/.test(h) ? 'threads' :
    h === 'bsky.app' ? 'bluesky' : null;
  if (!platform) return;

  const WANT = {
    x: /\/i\/api\/graphql\/[^/]+\/(HomeTimeline|HomeLatestTimeline|TweetDetail|SearchTimeline|UserTweets|ListLatestTweetsTimeline|Bookmarks)\b/,
    youtube: /\/youtubei\/v1\/(browse|next|search|reel\/reel_watch_sequence)\b/,
    tiktok: /\/api\/(recommend\/item_list|following\/item_list|post\/item_list|search\/(general|item)\/full|explore\/item_list|related\/item_list)\b/,
    instagram: /\/(graphql\/query|api\/graphql|api\/v1\/feed\/|api\/v1\/clips\/|api\/v1\/discover\/)/,
    threads: /\/(graphql\/query|api\/graphql)/,
    facebook: /^\/api\/graphql\/?$/,
    pinterest: /^\/(resource\/[A-Za-z]+Resource\/get\/?|_graphql\/?)$/,
    bluesky: /\/xrpc\/app\.bsky\.feed\.(getTimeline|getFeed|getListFeed|getAuthorFeed|getPostThread|searchPosts)\b/,
  }[platform];
  const wanted = u => { try { return WANT.test(new URL(u, location.href).pathname); } catch { return false; } };

  const send = (url, text) => {
    if (typeof text !== 'string' || text.length < 50) return;
    window.postMessage({ __feedmerge: 1, platform, kind: 'json', url: String(url), pageUrl: location.href, capturedAt: Date.now(), payload: text }, location.origin);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      if (url && wanted(url)) p.then(r => { if (r.ok) r.clone().text().then(t => send(url, t), () => {}); }, () => {});
    } catch {}
    return p;
  };

  const open = XMLHttpRequest.prototype.open;
  const xsend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__fmUrl = String(url); return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__fmUrl;
    if (url && wanted(url)) {
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          const rt = this.responseType;
          send(url, rt === '' || rt === 'text' ? this.responseText : rt === 'json' ? JSON.stringify(this.response) : null);
        } catch {}
      });
    }
    return xsend.apply(this, arguments);
  };

  // First screen of some sites arrives inside the HTML instead of a request.
  const initial = () => {
    const at = 'initial:' + location.href;
    try {
      if (platform === 'youtube' && window.ytInitialData) send(at, JSON.stringify(window.ytInitialData));
      if (platform === 'tiktok') { const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__'); if (el) send(at, el.textContent); }
      if (platform === 'instagram' || platform === 'threads') {
        for (const el of document.querySelectorAll('script[type="application/json"]')) {
          const t = el.textContent || '';
          if (t.includes('"taken_at"')) send(at, t);
        }
      }
      // Pinterest's first grid is server-rendered state in the HTML.
      if (platform === 'pinterest') {
        for (const el of document.querySelectorAll('script#__PWS_INITIAL_PROPS__, script#__PWS_DATA__, script[type="application/json"]')) {
          const t = el.textContent || '';
          if (t.includes('"images"') && t.includes('"pinner"')) send(at, t);
        }
      }
      // Facebook's first feed page is prefetched into the HTML as Relay data.
      if (platform === 'facebook') {
        for (const el of document.querySelectorAll('script[type="application/json"]')) {
          const t = el.textContent || '';
          if (t.includes('"__typename":"Story"') && t.includes('"post_id"')) send(at, t);
        }
      }
    } catch {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initial, { once: true });
  else initial();
})();
