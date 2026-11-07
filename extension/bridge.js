// Relays page-hook captures to the extension, and reads Reddit posts straight from the page.
const relay = cap => { try { chrome.runtime.sendMessage({ type: 'capture', cap }).catch(() => {}); } catch {} };

window.addEventListener('message', e => {
  const d = e.data;
  if (e.source !== window || !d || d.__feedmerge !== 1 || typeof d.payload !== 'string' || d.payload.length > 25e6) return;
  relay({ platform: d.platform, kind: d.kind, url: d.url, pageUrl: d.pageUrl, capturedAt: d.capturedAt, payload: d.payload });
});

// Background refresh: scroll a few screens so the feed loads more than its first page.
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type !== 'fm-autoscroll') return;
  let n = 0;
  const step = () => {
    window.scrollBy(0, Math.round(window.innerHeight * (0.8 + Math.random() * 0.6)));
    document.scrollingElement?.dispatchEvent(new Event('scroll'));
    if (++n < (msg.steps || 8)) setTimeout(step, 1800 + Math.random() * 1500);
  };
  step();
});

if (location.hostname.endsWith('reddit.com')) {
  const sent = new Set();
  let pageKey = location.href;
  const attr = (el, n) => el.getAttribute(n) || undefined;

  const scan = () => {
    if (location.href !== pageKey) { pageKey = location.href; sent.clear(); }
    const out = [];
    // New Reddit
    for (const el of document.querySelectorAll('shreddit-post')) {
      const id = attr(el, 'id') || attr(el, 'thingid');
      if (!id || sent.has(id)) continue;
      sent.add(id);
      const img = el.querySelector('img[src*="preview.redd.it"], img[src*="i.redd.it"], img[src*="external-preview.redd.it"]');
      const gallery = [...el.querySelectorAll('gallery-carousel img, [slot="post-media-container"] img')]
        .map(i => i.currentSrc || i.src || i.getAttribute('data-lazy-src') || '').filter(s => /redd\.it\//.test(s));
      out.push({
        postType: attr(el, 'post-type'),
        images: [...new Set(gallery)].slice(0, 10),
        icon: el.querySelector('img[src*="styles.redditmedia.com"], img[src*="communityIcon"], img[src*="community_icon"]')?.src,
        id, title: attr(el, 'post-title'), permalink: attr(el, 'permalink'), author: attr(el, 'author'),
        subreddit: attr(el, 'subreddit-prefixed-name'), score: attr(el, 'score'), comments: attr(el, 'comment-count'),
        created: attr(el, 'created-timestamp'), href: attr(el, 'content-href'),
        body: (el.querySelector('[slot="text-body"]')?.innerText || '').trim().slice(0, 4000) || undefined,
        thumb: img?.src, promoted: el.hasAttribute('is-promoted') || undefined,
      });
    }
    // Old Reddit
    for (const el of document.querySelectorAll('div.thing[data-fullname^="t3_"]')) {
      const id = el.dataset.fullname;
      if (sent.has(id)) continue;
      sent.add(id);
      out.push({
        id, title: el.querySelector('a.title')?.textContent?.trim(), permalink: el.dataset.permalink, author: el.dataset.author,
        subreddit: el.dataset.subredditPrefixed, score: el.dataset.score, comments: el.dataset.commentsCount,
        created: el.dataset.timestamp, href: el.dataset.url, thumb: el.querySelector('a.thumbnail img')?.src,
        promoted: el.dataset.promoted === 'true' || undefined,
      });
    }
    if (out.length) relay({ platform: 'reddit', kind: 'dom', url: 'dom:' + location.pathname, pageUrl: location.href, capturedAt: Date.now(), payload: JSON.stringify(out) });
  };

  let t = null;
  const soon = () => { if (!t) t = setTimeout(() => { t = null; scan(); }, 1500); };
  const start = () => { new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true }); soon(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
