// Native-looking cards per platform, plus the platforms' own official players/embeds.
// Cards are drawn from captured data so skimming is instant; "play" swaps in the real embed.
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const short = n => n == null ? '' : n >= 1e9 ? (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);
  const ago = t => {
    if (!t) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  };
  const dur = ms => { if (!ms) return ''; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const theme = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  // Images from hosts whose links expire or refuse other sites go through the local cache.
  const PROXY = /(^|\.)(fbcdn\.net|cdninstagram\.com|tiktokcdn\.com|tiktokcdn-us\.com)$/;
  const src = u => { try { return PROXY.test(new URL(u).hostname) ? '/media?u=' + encodeURIComponent(u) : u; } catch { return u; } };

  const I = {
    reply: '<svg viewBox="0 0 24 24"><path d="M1.75 10c0-4.4 3.6-8 8-8h4.36c4.5 0 8.14 3.64 8.14 8.13 0 2.96-1.6 5.68-4.2 7.11L10 21.5V18.1h-.07c-4.5.1-8.18-3.5-8.18-8.1zm8-6c-3.32 0-6 2.69-6 6 0 3.37 2.77 6.08 6.13 6.01l.35-.01H12v2.1l5.13-2.84c1.95-1.07 3.12-3.1 3.12-5.13 0-3.39-2.75-6.13-6.14-6.13H9.75z"/></svg>',
    repost: '<svg viewBox="0 0 24 24"><path d="M4.5 3.88l4.43 4.14-1.37 1.46L5.5 7.55V16c0 1.1.9 2 2 2H13v2H7.5c-2.21 0-4-1.79-4-4V7.55L1.44 9.48.07 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.21 0 4 1.79 4 4v8.45l2.06-1.93 1.37 1.46-4.43 4.14-4.43-4.14 1.37-1.46 2.06 1.93V8c0-1.1-.9-2-2-2z"/></svg>',
    like: '<svg viewBox="0 0 24 24"><path d="M16.7 3.5c-1.6 0-3.1.8-4.2 2.1l-.5.5-.5-.5C10.4 4.3 8.9 3.5 7.3 3.5 4.1 3.5 1.75 6 1.75 9.1c0 5.6 7.1 10.3 9.8 11.9.3.2.6.2.9 0 2.7-1.6 9.8-6.3 9.8-11.9 0-3.1-2.35-5.6-5.55-5.6zm-4.7 15.5C9.1 17.1 3.75 13.2 3.75 9.1c0-2 1.55-3.6 3.55-3.6 1.3 0 2.5.7 3.2 1.8l1.5 2 1.5-2c.7-1.1 1.9-1.8 3.2-1.8 2 0 3.55 1.6 3.55 3.6 0 4.1-5.35 8-8.25 9.9z"/></svg>',
    heartFill: '<svg viewBox="0 0 24 24"><path d="M12 21.6c-.2 0-.4-.1-.6-.2C8.7 19.8 1.75 15.1 1.75 9.1 1.75 6 4.1 3.5 7.3 3.5c1.6 0 3.1.8 4.2 2.1l.5.5.5-.5c1.1-1.3 2.6-2.1 4.2-2.1 3.2 0 5.55 2.5 5.55 5.6 0 6-6.95 10.7-9.65 12.3-.2.1-.4.2-.6.2z"/></svg>',
    views: '<svg viewBox="0 0 24 24"><path d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z"/></svg>',
    comment: '<svg viewBox="0 0 24 24"><path d="M20.66 19.53A10 10 0 1 0 17.5 21l3.5 1-1-3.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M22 3 9.2 10.1M22 3l-7 19-4.8-11.9L2 6.5 22 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M20 21l-8-7.6L4 21V3h16v18z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    up: '<svg viewBox="0 0 20 20"><path d="M10 2.5 2.5 10.5h4.5v7h6v-7h4.5L10 2.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 20 20"><path d="M10 17.5 17.5 9.5H13v-7H7v7H2.5L10 17.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 20 20"><path d="M12 3l6 6-6 6v-3.5C7 11.5 4.5 13 2.5 17c.5-5 3-9 9.5-10V3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91C2.63 9.33 1.75 10.57 1.75 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z"/></svg>',
    music: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    reels: '<svg viewBox="0 0 24 24"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2.5 8h19M9 2.5 12 8M15 2.5 18 8M10 11.5v6l5-3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    bsky: '<svg viewBox="0 0 24 24"><path d="M6.3 3.6C8.6 5.3 11.1 8.8 12 10.7c.9-1.9 3.4-5.4 5.7-7.1 1.7-1.2 4.3-2.2 4.3.8 0 .6-.3 5-.5 5.7-.7 2.4-3.2 3.1-5.4 2.7 3.9.7 4.9 2.9 2.7 5.1-4.1 4.2-5.9-1.1-6.4-2.4l-.4-1-.4 1c-.5 1.3-2.3 6.6-6.4 2.4-2.2-2.2-1.2-4.4 2.7-5.1-2.2.4-4.7-.3-5.4-2.7C2.8 9.4 2.5 5 2.5 4.4c0-3 2.6-2 4.3-.8z"/></svg>',
  };

  const avatar = (it, size = 40, round = true) => {
    const a = it.flags?.avatar;
    const letter = esc((it.authorName || it.author || '?').replace(/^[ru]\//, '').trim()[0]?.toUpperCase() || '?');
    return a
      ? `<img class="av" style="width:${size}px;height:${size}px;border-radius:${round ? '50%' : '8px'}" src="${esc(src(a))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;av av-l&quot; style=&quot;width:${size}px;height:${size}px&quot;>${letter}</span>'">`
      : `<span class="av av-l" style="width:${size}px;height:${size}px;border-radius:${round ? '50%' : '8px'}">${letter}</span>`;
  };

  // Post text with links, @mentions and #tags styled like the platform does.
  function richText(text, platform) {
    let t = esc(text);
    t = t.replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 32)}${u.length > 40 ? '…' : ''}</a>`);
    const base = { x: 'https://x.com/', instagram: 'https://www.instagram.com/', threads: 'https://www.threads.com/@', bluesky: 'https://bsky.app/profile/', tiktok: 'https://www.tiktok.com/@' }[platform];
    if (base) t = t.replace(/(^|[\s(])@([\w.]{2,30})/g, (m, s, h) => `${s}<a href="${base}${h}" target="_blank" rel="noopener noreferrer">@${h}</a>`);
    t = t.replace(/(^|\s)#([\p{L}\p{N}_]+)/gu, (m, s, h) => `${s}<span class="tag-link">#${h}</span>`);
    return t;
  }

  const img = (m, cls = '') => `<img class="${cls}" src="${esc(src(m.url))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('broken')">`;
  // A direct video file plays inline (muted autoplay when on screen, like the apps). Falls back to the poster.
  const vid = (m, cls = '') => m.video
    ? `<div class="vwrap ${cls}"><video data-src="${esc(m.video)}" poster="${esc(src(m.url))}" muted playsinline preload="none" ${m.type === 'gif' ? 'loop' : ''}></video>${m.type === 'gif' ? '<span class="badge">GIF</span>' : `<span class="badge">${dur(m.duration)}</span>`}<button class="unmute" data-unmute aria-label="Sound">🔇</button></div>`
    : `<div class="vwrap ${cls}">${img(m)}<span class="badge">${m.type === 'video' ? dur(m.duration) || '▶' : ''}</span></div>`;
  const one = (m, cls) => (m.type === 'video' || m.type === 'gif' ? vid(m, cls) : img(m, cls));

  // Keep ordinary previews compact, with at most 25% of the first image cropped.
  // Very wide strips often contain text: their real ratio wins over a fixed box.
  function frameAspect(w, h, fallback = 4 / 3) {
    const ratio = Number(w) > 0 && Number(h) > 0 ? Number(w) / Number(h) : fallback;
    if (!Number.isFinite(ratio) || ratio <= 0) return fallback;
    if (ratio >= 3) return ratio;
    return Math.max(ratio * .75, Math.min(ratio / .75, Math.max(.8, Math.min(1.91, ratio))));
  }
  const frame = (m, fallback) => `data-media-frame style="--media-ratio:${frameAspect(m?.w, m?.h, fallback)};aspect-ratio:var(--media-ratio)"`;

  function grid(media) {
    const ms = media.filter(m => m.url).slice(0, 4);
    if (!ms.length) return '';
    if (ms.length === 1) {
      const m = ms[0];
      return `<div class="mgrid g1" ${frame(m, 4 / 3)}>${one(m)}</div>`;
    }
    return `<div class="mgrid g${ms.length}">${ms.map(m => one(m)).join('')}</div>`;
  }

  function carousel(media, ratio = '4 / 5') {
    const ms = media.filter(m => m.url);
    if (!ms.length) return '';
    const fallback = ratio.split('/').reduce((a, b) => Number(a) / Number(b));
    if (ms.length === 1) return `<div class="car" ${frame(ms[0], fallback)}><div class="track">${one(ms[0], 'slide')}</div></div>`;
    return `<div class="car" ${frame(ms[0], fallback)}><div class="track" data-track>${ms.map(m => `<div class="slide">${one(m)}</div>`).join('')}</div>
      <span class="count" data-count>1/${ms.length}</span><div class="dots">${ms.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div></div>`;
  }

  const act = (icon, n, cls = '') => `<span class="act act-${icon} ${cls}">${I[icon]}${n != null && n !== '' ? `<b>${short(n)}</b>` : ''}</span>`;

  // ---------- Platform renderers ----------
  const R = {};

  R.x = it => {
    const m = it.metrics, f = it.flags;
    const q = f.quote;
    return `
      ${f.repostedBy ? `<div class="x-rt">${I.repost}<span>@${esc(f.repostedBy)} reposted</span></div>` : ''}
      <div class="x-row">
        <div class="x-left">${avatar(it, 40)}</div>
        <div class="x-body">
          <div class="x-head"><b>${esc(it.authorName || it.author)}</b>${f.verified ? `<span class="ver">${I.check}</span>` : ''}<span class="mute">@${esc(it.author)} · ${ago(it.publishedAt)}</span></div>
          ${it.text ? `<div class="x-text">${richText(it.text, 'x')}</div>` : ''}
          ${grid(it.media)}
          ${q ? `<a class="x-quote" href="${esc(q.url)}" target="_blank" rel="noopener noreferrer"><div class="x-head">${avatar({ flags: { avatar: q.avatar }, author: q.author }, 20)}<b>${esc(q.name || q.author)}</b><span class="mute">@${esc(q.author)}</span></div><div class="x-text">${esc(q.text)}</div>${q.media?.[0]?.url ? grid([q.media[0]]) : ''}</a>` : ''}
          <div class="x-acts">${act('reply', m.replies)}${act('repost', m.reposts, 'g')}${act('like', m.likes, 'p')}${act('views', m.views)}<span class="grow"></span>${embedBtn(it)}</div>
        </div>
      </div>`;
  };

  R.bluesky = it => {
    const m = it.metrics, f = it.flags;
    return `<div class="x-row">
      <div class="x-left">${avatar(it, 42)}</div>
      <div class="x-body">
        <div class="x-head"><b>${esc(it.authorName || it.author)}</b><span class="mute">@${esc(it.author)} · ${ago(it.publishedAt)}</span><span class="grow"></span><span class="bs-logo">${I.bsky}</span></div>
        ${it.text ? `<div class="x-text">${richText(it.text, 'bluesky')}</div>` : ''}
        ${grid(it.media.filter(x => x.type !== 'link'))}
        ${f.link ? `<a class="linkcard" href="${esc(f.link)}" target="_blank" rel="noopener noreferrer">${it.media.find(x => x.type === 'link') ? img(it.media.find(x => x.type === 'link')) : ''}<div><span class="mute">${esc(host(f.link))}</span><b>${esc(f.linkTitle || '')}</b></div></a>` : ''}
        <div class="x-acts">${act('reply', m.replies)}${act('repost', m.reposts, 'g')}${act('like', m.likes, 'p')}<span class="grow"></span>${embedBtn(it)}</div>
      </div></div>`;
  };

  R.threads = it => {
    const m = it.metrics;
    return `<div class="x-row">
      <div class="x-left">${avatar(it, 36)}</div>
      <div class="x-body">
        <div class="x-head"><b>${esc(it.author)}</b>${it.flags.verified ? `<span class="ver th">${I.check}</span>` : ''}<span class="mute">${ago(it.publishedAt)}</span></div>
        ${it.text ? `<div class="x-text">${richText(it.text, 'threads')}</div>` : ''}
        ${it.media.length > 1 ? carousel(it.media, '3 / 4') : grid(it.media)}
        <div class="x-acts th-acts">${act('like', m.likes)}${act('comment', m.comments)}${act('repost', m.reposts)}${act('send')}<span class="grow"></span>${embedBtn(it)}</div>
      </div></div>`;
  };

  R.reddit = it => {
    const m = it.metrics, f = it.flags;
    const sub = it.authorName || '';
    return `<div class="rd-head">${avatar({ flags: f, authorName: sub.replace(/^r\//, '') }, 24)}<b>${esc(sub)}</b><span class="mute">• ${ago(it.publishedAt)}</span><span class="grow"></span>${f.ad ? '<span class="mute">Promoted</span>' : ''}</div>
      <div class="rd-title">${esc(it.title || '')}</div>
      ${f.link ? `<a class="rd-link" href="${esc(f.link)}" target="_blank" rel="noopener noreferrer">${esc(host(f.link))} ↗</a>` : ''}
      ${it.text ? `<div class="rd-text clamp6">${richText(it.text, 'reddit')}</div>` : ''}
      ${it.media.length > 1 ? carousel(it.media, '4 / 3') : it.media[0] ? `<div class="rd-media" ${frame(it.media[0], 4 / 3)}>${one(it.media[0])}</div>` : ''}
      <div class="rd-acts"><span class="pill vote">${I.up}<b>${short(m.score) || 'Vote'}</b>${I.down}</span><span class="pill">${I.comment}<b>${short(m.comments) || 0}</b></span><span class="pill pill-share">${I.share}<b>Share</b></span><span class="grow"></span>${embedBtn(it)}</div>`;
  };

  R.youtube = it => {
    const m = it.metrics, f = it.flags;
    const media = it.media[0];
    if (f.short || it.context === 'shorts') {
      return `<div class="vt yt-short" data-play>
        ${media ? img(media, 'vt-bg') : ''}<div class="vt-grad"></div>
        <div class="vt-play">${I.play}</div>
        <div class="vt-meta"><b>${esc(it.title || '')}</b><span>${m.views != null ? short(m.views) + ' views' : ''}</span></div>
        <span class="vt-logo yt">Shorts</span></div>`;
    }
    return `<div class="yt-thumb" data-play>${media ? img(media) : ''}${m.duration ? `<span class="badge">${esc(m.duration)}</span>` : ''}<div class="vt-play sm">${I.play}</div></div>
      <div class="yt-row">${avatar(it, 36)}<div><div class="yt-title">${esc(it.title || '')}</div><div class="mute">${esc(it.author || '')}</div><div class="mute">${[m.views != null ? short(m.views) + ' views' : '', m.ago || (it.publishedAt ? ago(it.publishedAt) + ' ago' : '')].filter(Boolean).join(' • ')}</div></div></div>`;
  };

  R.tiktok = it => {
    const m = it.metrics, f = it.flags;
    const photos = it.media.filter(x => x.type === 'image');
    return `<div class="vt tt" data-play>
      ${photos.length > 1 ? carousel(photos, '9 / 16') : it.media[0] ? img(it.media[0], 'vt-bg') : ''}<div class="vt-grad"></div>
      ${photos.length > 1 ? '' : `<div class="vt-play">${I.play}</div>`}
      <div class="vt-rail">${avatar(it, 44)}<span>${I.heartFill}<b>${short(m.likes)}</b></span><span>${I.comment}<b>${short(m.comments)}</b></span><span>${I.save}<b>${short(m.saves)}</b></span><span>${I.share}<b>${short(m.shares)}</b></span></div>
      <div class="vt-meta"><b>@${esc(it.author)}</b><span class="clamp2">${richText(it.text, 'tiktok')}</span>${f.music ? `<span class="music">${I.music}${esc(f.music)}</span>` : ''}</div>
      <span class="vt-logo">${m.views != null ? '▷ ' + short(m.views) : ''}</span></div>`;
  };

  R.instagram = it => {
    const m = it.metrics, f = it.flags;
    if (f.reel || it.context === 'reels') {
      const v = it.media[0];
      return `<div class="vt ig-reel" data-play>
        ${v?.video ? `<video class="vt-bg" data-src="${esc(v.video)}" poster="${esc(src(v.url))}" muted playsinline loop preload="none"></video><button class="unmute" data-unmute aria-label="Sound">🔇</button>` : v ? img(v, 'vt-bg') : ''}
        <div class="vt-grad"></div>
        <div class="vt-rail">${act('like', m.likes)}${act('comment', m.comments)}${act('send')}</div>
        <div class="vt-meta"><span class="ig-who">${avatar(it, 28)}<b>${esc(it.author)}</b>${embedBtn(it)}</span><span class="clamp2">${richText(it.text, 'instagram')}</span>${f.music ? `<span class="music">${I.music}${esc(f.music)}</span>` : ''}</div>
        <span class="vt-logo">${I.reels}</span></div>`;
    }
    return `<div class="ig-head">${avatar(it, 32)}<b>${esc(it.author)}</b>${f.verified ? `<span class="ver ig">${I.check}</span>` : ''}<span class="mute">• ${ago(it.publishedAt)}</span></div>
      ${carousel(it.media)}
      <div class="ig-acts">${I.like}${I.comment}${I.send}<span class="grow"></span>${I.save}</div>
      ${m.likes != null ? `<div class="ig-likes">${short(m.likes)} likes</div>` : ''}
      ${it.text ? `<div class="ig-cap clamp3"><b>${esc(it.author)}</b> ${richText(it.text, 'instagram')}</div>` : ''}
      ${m.comments ? `<div class="mute ig-more">View all ${short(m.comments)} comments</div>` : ''}
      <div class="ig-foot">${embedBtn(it)}</div>`;
  };

  // General pages, kept minimal: the site's icon and whichever is shorter, its name or its
  // address, then the title (and summary/picture if any).
  R.web = it => {
    const h = host(it.url);
    const m = it.media[0];
    const name = it.context && it.context.length < h.length ? it.context : h;
    return `<div class="web-head"><img class="fav" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=32" alt="" referrerpolicy="no-referrer"><b title="${esc(it.context || h)}">${esc(name)}</b><span class="mute">· ${ago(it.publishedAt || it.firstSeen)}</span></div>
      <a class="web-main" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer"><div><div class="web-title">${esc(it.title || '')}</div>${it.text ? `<div class="web-text clamp3">${esc(it.text)}</div>` : ''}</div>${m ? img(m, 'web-img') : ''}</a>`;
  };

  // ---------- Official embeds ----------
  function embedUrl(it) {
    const t = theme();
    switch (it.platform) {
      case 'youtube': return { src: `https://www.youtube-nocookie.com/embed/${it.nativeId}?autoplay=1&rel=0&playsinline=1`, ratio: it.flags.short || it.context === 'shorts' ? '9 / 16' : '16 / 9' };
      case 'tiktok': return { src: `https://www.tiktok.com/player/v1/${it.nativeId}?autoplay=1&description=1&music_info=1&rel=0&native_context_menu=0`, ratio: '9 / 16' };
      case 'instagram': return { src: `https://www.instagram.com/${it.flags.reel ? 'reel' : 'p'}/${it.nativeId}/embed/captioned/`, height: 720 };
      case 'threads': return { src: `https://www.threads.com/@${it.author}/post/${it.nativeId}/embed`, height: 620 };
      case 'bluesky': return { src: `https://embed.bsky.app/embed/${it.nativeId}?colorMode=${t === 'dark' ? 'dark' : 'light'}`, height: 420 };
      case 'reddit': { try { return { src: `https://embed.reddit.com${new URL(it.url).pathname}?embed=true&theme=${t}&showmedia=true`, height: 620 }; } catch { return null; } }
      case 'x': return { x: true };
    }
    return null;
  }
  const PLAY_LABEL = { youtube: 'Play', tiktok: 'Play', instagram: 'View on Instagram here', threads: 'View thread here', bluesky: 'View on Bluesky here', reddit: 'View on Reddit here', x: 'View on X here' };
  function embedBtn(it) { return embedUrl(it) ? `<button class="embed-btn" data-embed>${esc(PLAY_LABEL[it.platform] || 'Embed')}</button>` : ''; }

  let xLoading = null;
  const loadX = () => xLoading || (xLoading = new Promise(res => {
    const s = document.createElement('script');
    s.src = 'https://platform.twitter.com/widgets.js';
    s.async = true;
    s.onload = () => res(window.twttr);
    s.onerror = () => res(null);
    document.head.appendChild(s);
  }));

  async function openEmbed(card, it) {
    const e = embedUrl(it);
    if (!e) return;
    card.querySelectorAll('video').forEach(v => v.pause());
    const box = document.createElement('div');
    box.className = 'embed';
    box.innerHTML = '<div class="embed-bar"><span>Embedded from ' + esc(it.platform) + '</span><button data-unembed>Close</button></div>';
    const body = card.querySelector('.n-body');
    body.hidden = true;
    body.after(box);
    if (e.x) {
      const tw = await loadX();
      const holder = document.createElement('div');
      box.appendChild(holder);
      if (tw?.widgets) await tw.widgets.createTweet(it.nativeId, holder, { theme: theme(), dnt: true, align: 'center' });
      if (!holder.childElementCount) holder.innerHTML = `<p class="mute">X's embed didn't load. <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">Open on X</a></p>`;
      return;
    }
    const f = document.createElement('iframe');
    f.src = e.src;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write';
    f.allowFullscreen = true;
    f.loading = 'eager';
    if (e.ratio) f.style.aspectRatio = e.ratio; else f.style.height = e.height + 'px';
    if (e.ratio === '9 / 16') f.classList.add('tall');
    box.appendChild(f);
  }

  // Embeds that report their height (Instagram, Bluesky, Reddit, Threads) resize to fit.
  window.addEventListener('message', ev => {
    const frame = [...document.querySelectorAll('.embed iframe')].find(f => f.contentWindow === ev.source);
    if (!frame || frame.style.aspectRatio) return;
    let d = ev.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    const h = Number(d?.details?.height ?? d?.height ?? (d?.type === 'resize.embed' ? d.data : undefined));
    if (h > 80 && h < 5000) frame.style.height = Math.ceil(h) + 'px';
  });

  // Inline videos: play muted while mostly on screen, like the apps; only one at a time.
  const vio = new IntersectionObserver(entries => {
    for (const e of entries) {
      const v = e.target;
      if (e.isIntersecting && e.intersectionRatio >= 0.6) {
        if (!v.src && v.dataset.src) v.src = v.dataset.src;
        document.querySelectorAll('video').forEach(o => { if (o !== v && !o.paused) o.pause(); });
        v.play().catch(() => {});
      } else if (!v.paused) v.pause();
    }
  }, { threshold: [0, 0.6] });

  function mount(root) {
    root.querySelectorAll('[data-media-frame]:not([data-frame-obs])').forEach(box => {
      box.dataset.frameObs = '1';
      if (box.closest('.vt')) return; // reels/shorts retain their own fixed frame
      const media = [...box.querySelectorAll('img, video')], first = media[0];
      const sync = () => {
        const w = first?.naturalWidth || first?.videoWidth, h = first?.naturalHeight || first?.videoHeight;
        if (w && h) box.style.setProperty('--media-ratio', frameAspect(w, h));
        const ratio = Number(box.style.getPropertyValue('--media-ratio'));
        for (const item of media) {
          const iw = item.naturalWidth || item.videoWidth, ih = item.naturalHeight || item.videoHeight;
          // An unusually different gallery slide is kept whole rather than losing
          // most of it. Normal photos fill their frame; the first slide never jumps.
          const retained = iw && ih ? Math.min((iw / ih) / ratio, ratio / (iw / ih)) : 1;
          item.style.objectFit = retained >= .65 ? 'cover' : 'contain';
        }
      };
      for (const item of media) { item.addEventListener('load', sync); item.addEventListener('loadedmetadata', sync); }
      sync();
    });
    root.querySelectorAll('video[data-src]:not([data-obs])').forEach(v => {
      v.dataset.obs = '1';
      vio.observe(v);
      v.addEventListener('error', () => {
        if (!v.poster) return;
        const im = document.createElement('img');
        im.src = v.poster;
        im.className = v.className;
        im.referrerPolicy = 'no-referrer';
        vio.unobserve(v);
        v.replaceWith(im);
      }, { once: true });
    });
    root.querySelectorAll('[data-track]:not([data-obs])').forEach(t => {
      t.dataset.obs = '1';
      t.addEventListener('scroll', () => {
        const i = Math.round(t.scrollLeft / t.clientWidth);
        const car = t.closest('.car');
        car.querySelector('[data-count]').textContent = `${i + 1}/${t.children.length}`;
        car.querySelectorAll('.dots i').forEach((d, k) => d.classList.toggle('on', k === i));
      }, { passive: true });
    });
  }

  function render(it, extra) {
    const r = R[it.platform] || R.web;
    return `<article class="card n p-${esc(it.platform)}" data-id="${esc(it.id)}"><div class="n-body">${r(it)}</div>${extra || ''}</article>`;
  }

  function handleClick(e, it, card) {
    const t = e.target;
    if (t.closest('[data-unembed]')) { card.querySelector('.embed')?.remove(); card.querySelector('.n-body').hidden = false; return true; }
    if (t.closest('[data-unmute]')) {
      const v = t.closest('.vwrap, .vt').querySelector('video');
      if (v) { v.muted = !v.muted; t.closest('[data-unmute]').textContent = v.muted ? '🔇' : '🔊'; if (v.paused) v.play().catch(() => {}); }
      return true;
    }
    if (t.closest('video')) { const v = t.closest('video'); if (!v.src && v.dataset.src) v.src = v.dataset.src; v.paused ? v.play().catch(() => {}) : v.pause(); return true; }
    if (t.closest('[data-embed]') || (t.closest('[data-play]') && !t.closest('a, [data-track]'))) { openEmbed(card, it); return true; }
    return false;
  }

  window.Native = { render, mount, handleClick, ago, short, esc, frameAspect };
})();
