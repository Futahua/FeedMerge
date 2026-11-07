const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const NAMES = { web: 'Web', x: 'X', youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', threads: 'Threads', bluesky: 'Bluesky', reddit: 'Reddit' };
const ago = t => {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString();
};
const short = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);

const state = { platforms: new Set(), context: '', topic: '', story: '', q: '', sort: 'captured', saved: false, ads: false, offset: 0, done: false, loading: false, newest: 0 };
try { const s = JSON.parse(localStorage.getItem('fm-view') || '{}'); if (s.sort) state.sort = s.sort; if (s.platforms) state.platforms = new Set(s.platforms); } catch {}
const remember = () => { try { localStorage.setItem('fm-view', JSON.stringify({ sort: state.sort, platforms: [...state.platforms] })); } catch {} };

function params(extra = {}) {
  const p = new URLSearchParams();
  if (state.platforms.size) p.set('platform', [...state.platforms].join(','));
  for (const k of ['context', 'topic', 'story', 'q']) if (state[k]) p.set(k, state[k]);
  if (state.saved) p.set('saved', '1');
  if (state.ads) p.set('ads', '1');
  p.set('sort', state.sort === 'balanced' ? 'captured' : state.sort);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

// Round-robin a page across platforms so one busy source doesn't drown the rest.
function balance(items) {
  const groups = new Map();
  for (const it of items) (groups.get(it.platform) || groups.set(it.platform, []).get(it.platform)).push(it);
  const out = [];
  const qs = [...groups.values()];
  while (out.length < items.length) for (const g of qs) if (g.length) out.push(g.shift());
  return out;
}

function card(it) {
  const m = it.metrics || {};
  const stats = [
    m.views != null && `${short(m.views)} views`, m.likes != null && `${short(m.likes)} likes`, m.score != null && `${short(m.score)} points`,
    m.comments != null && `${short(m.comments)} comments`, m.replies != null && `${short(m.replies)} replies`, m.reposts != null && `${short(m.reposts)} reposts`, m.duration,
  ].filter(Boolean);
  const img = it.media?.find(x => x.url);
  const posted = it.publishedAt ? ago(it.publishedAt) : m.ago || '';
  const text = it.text || '';
  return `<article class="card" style="--pf: var(--${esc(it.platform)})" data-id="${esc(it.id)}">
    <div class="meta">
      <span class="pf">${esc(NAMES[it.platform] || it.platform)}</span>
      ${it.author ? `<span class="who">${esc(it.authorName && it.platform !== 'reddit' ? it.authorName : it.author)}</span>` : ''}
      ${it.platform === 'reddit' && it.authorName ? `<span>${esc(it.authorName)}</span>` : it.author && it.authorName ? `<span>@${esc(it.author)}</span>` : ''}
      ${it.flags?.repostedBy ? `<span>reposted by @${esc(it.flags.repostedBy)}</span>` : ''}
      <span class="ctx">${esc(it.context || '')}</span>
      <span class="spacer"></span>
      <span title="posted">${esc(posted)}</span>
      <button class="star ${it.saved ? 'on' : ''}" data-save title="Save">${it.saved ? '★' : '☆'}</button>
    </div>
    ${it.title ? `<div class="title">${esc(it.title)}</div>` : ''}
    ${text ? `<div class="text ${text.length > 500 ? 'clamp' : ''}">${esc(text)}</div>` : ''}
    ${it.flags?.quote ? `<div class="quote">@${esc(it.flags.quote.author)}: ${esc(it.flags.quote.text)}</div>` : ''}
    ${img ? `<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer"><img class="thumb" loading="lazy" referrerpolicy="no-referrer" src="${esc(img.url)}" alt="" onerror="this.remove()"></a>` : ''}
    <div class="foot2">
      ${stats.map(esc).join(' · ')}
      ${it.seenCount > 1 ? `<span title="times the platform showed this to you">shown ${it.seenCount}×</span>` : ''}
      ${it.story ? `<button class="tag story" data-story="${esc(it.story)}">${esc(it.story)}</button>` : ''}
      ${(it.topics || []).map(t => `<button class="tag" data-topic="${esc(t)}">${esc(t)}</button>`).join('')}
      <span class="spacer"></span>
      <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">Open</a>
    </div>
  </article>`;
}

async function load(reset) {
  if (state.loading || (state.done && !reset)) return;
  state.loading = true;
  if (reset) { state.offset = 0; state.done = false; $('#feed').innerHTML = ''; $('#fresh').hidden = true; }
  $('#more').textContent = 'Loading…';
  try {
    let items = await (await fetch('/api/items?' + params({ limit: 50, offset: state.offset }))).json();
    if (reset) state.newest = items[0]?.firstSeen || Date.now();
    state.offset += items.length;
    state.done = items.length < 50;
    if (state.sort === 'balanced') items = balance(items);
    $('#feed').insertAdjacentHTML('beforeend', items.map(card).join(''));
    if (reset && !items.length) $('#feed').innerHTML = `<div class="empty">Nothing here yet. Load the FeedMerge extension in Chrome, then scroll X, YouTube, TikTok, Instagram, Threads, Bluesky or Reddit as usual. Posts show up here within seconds.</div>`;
    $('#more').textContent = state.done ? (state.offset ? 'That’s everything.' : '') : '';
  } catch { $('#more').textContent = 'Server not reachable.'; }
  state.loading = false;
}

async function facets() {
  const f = await (await fetch('/api/facets')).json();
  $('#platforms').innerHTML = f.platforms.map(p => `<button class="chip ${state.platforms.has(p.platform) ? 'on' : ''}" data-pf="${esc(p.platform)}">${esc(NAMES[p.platform] || p.platform)}<span class="n">${p.n}</span></button>`).join('') || '<span class="foot">No captures yet</span>';
  const ctx = f.contexts.filter(c => !state.platforms.size || state.platforms.has(c.platform));
  $('#contexts').innerHTML = ctx.slice(0, 14).map(c => `<button data-ctx="${esc(c.context)}" class="${state.context === c.context ? 'on' : ''}"><span>${esc(NAMES[c.platform] || c.platform)} · ${esc(c.context)}</span><span class="n">${c.n}</span></button>`).join('');
  $('#stories').innerHTML = f.stories.map(s => `<button data-story="${esc(s.story)}" class="${state.story === s.story ? 'on' : ''}"><span>${esc(s.story)}</span><span class="n">${s.n} · ${s.platforms}p</span></button>`).join('');
  $('#topics').innerHTML = f.topics.map(t => `<button class="chip ${state.topic === t.topic ? 'on' : ''}" data-topic="${esc(t.topic)}">${esc(t.topic)}<span class="n">${t.n}</span></button>`).join('');
  $('#storiesBox').hidden = !f.stories.length;
  $('#topicsBox').hidden = !f.topics.length;
  $('#status').innerHTML = [
    `<div><span>Items</span><span>${f.total.n}</span></div>`,
    `<div><span>Captures kept</span><span>${f.captures}</span></div>`,
    ...f.platforms.map(p => `<div><span>${esc(NAMES[p.platform] || p.platform)} last</span><span>${ago(p.last)} ago</span></div>`),
    `<div><span>AI labels</span><span>${f.ai.enabled ? `${f.ai.pending} waiting` : 'off'}</span></div>`,
  ].join('');
}

function renderActive() {
  const chips = [];
  if (state.context) chips.push(['context', `From: ${state.context}`]);
  if (state.topic) chips.push(['topic', `Topic: ${state.topic}`]);
  if (state.story) chips.push(['story', `Story: ${state.story}`]);
  $('#active').innerHTML = chips.map(([k, l]) => `<button class="chip on" data-clear="${k}">${esc(l)} ✕</button>`).join('');
}

function refresh() { remember(); renderActive(); facets(); load(true); }

document.addEventListener('click', async e => {
  const t = e.target.closest('button, .text.clamp');
  if (!t) return;
  if (t.classList.contains('clamp')) { t.classList.remove('clamp'); return; }
  if (t.dataset.pf) { state.platforms.has(t.dataset.pf) ? state.platforms.delete(t.dataset.pf) : state.platforms.add(t.dataset.pf); state.context = ''; return refresh(); }
  if (t.dataset.ctx != null) { state.context = state.context === t.dataset.ctx ? '' : t.dataset.ctx; return refresh(); }
  if (t.dataset.topic) { state.topic = state.topic === t.dataset.topic ? '' : t.dataset.topic; return refresh(); }
  if (t.dataset.story) { state.story = state.story === t.dataset.story ? '' : t.dataset.story; return refresh(); }
  if (t.dataset.clear) { state[t.dataset.clear] = ''; return refresh(); }
  if (t.hasAttribute('data-save')) {
    const id = t.closest('.card').dataset.id;
    const on = !t.classList.contains('on');
    await fetch(`/api/items/${encodeURIComponent(id)}/save`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-feedmerge': '1' }, body: JSON.stringify({ saved: on }) });
    t.classList.toggle('on', on);
    t.textContent = on ? '★' : '☆';
  }
});

let qTimer;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value.trim(); load(true); }, 250); });
$('#sort').value = state.sort;
$('#sort').addEventListener('change', e => { state.sort = e.target.value; remember(); load(true); });
$('#saved').addEventListener('change', e => { state.saved = e.target.checked; load(true); });
$('#ads').addEventListener('change', e => { state.ads = e.target.checked; load(true); });
$('#menu').addEventListener('click', () => $('#side').classList.toggle('open'));
$('#fresh').addEventListener('click', () => { window.scrollTo(0, 0); refresh(); });

new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) load(false); }, { rootMargin: '800px' }).observe($('#more'));

// Tell the reader when new posts have arrived instead of shuffling the list under them.
setInterval(async () => {
  if (document.hidden || state.sort === 'published' || state.sort === 'repeated') return;
  try {
    const items = await (await fetch('/api/items?' + params({ limit: 200, since: state.newest }))).json();
    $('#fresh').hidden = !items.length;
    $('#fresh').textContent = `${items.length}${items.length === 200 ? '+' : ''} new posts — show`;
  } catch {}
}, 20000);
setInterval(() => { if (!document.hidden) facets(); }, 60000);

// ---------- Web sources ----------
const POST = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-feedmerge': '1' }, body: JSON.stringify(body || {}) });

async function loadSources() {
  const list = await (await fetch('/api/sources')).json();
  $('#srcList').innerHTML = list.length ? list.map(s => `<div class="src ${s.enabled ? '' : 'off'}" data-src="${s.id}">
      <div class="nm">${esc(s.name)}</div>
      <div class="acts">
        <button class="btn" data-src-act="refresh">Refresh</button>
        <button class="btn" data-src-act="toggle">${s.enabled ? 'Pause' : 'Resume'}</button>
        <button class="btn" data-src-act="delete">Remove</button>
      </div>
      <div class="sub">${s.kind === 'page' ? 'Watched page' : 'Feed'} · every ${s.interval_min} min · ${s.items} items · checked ${s.last_fetch ? ago(s.last_fetch) + ' ago' : 'never'}</div>
      <div class="sub">${esc(s.url)}</div>
      ${s.last_error ? `<div class="err">Last check failed: ${esc(s.last_error)}</div>` : ''}
    </div>`).join('') : '<p class="hint">No web sources yet.</p>';
}

$('#sourcesBtn').addEventListener('click', () => { $('#sourcesDlg').showModal(); loadSources(); });
$('#closeSources').addEventListener('click', () => { $('#sourcesDlg').close(); refresh(); });
try { $('#srcLocale').value = localStorage.getItem('fm-locale') || 'en-US'; } catch {}
$('#addSource').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#srcInput').value.trim();
  if (!input) return;
  try { localStorage.setItem('fm-locale', $('#srcLocale').value); } catch {}
  $('#srcAdd').disabled = true;
  $('#srcMsg').textContent = 'Looking for a feed…';
  try {
    const r = await POST('/api/sources', { input, locale: $('#srcLocale').value });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    $('#srcMsg').textContent = `Added “${j.name}” as ${j.kind === 'page' ? 'a watched page' : 'a feed'}${j.last_count != null ? ` with ${j.last_count} items` : ''}.`;
    $('#srcInput').value = '';
    loadSources();
  } catch (err) { $('#srcMsg').textContent = `Couldn't add it: ${err.message}`; }
  $('#srcAdd').disabled = false;
});
$('#srcList').addEventListener('click', async e => {
  const b = e.target.closest('[data-src-act]');
  if (!b) return;
  const id = b.closest('[data-src]').dataset.src;
  b.disabled = true;
  await POST(`/api/sources/${id}/${b.dataset.srcAct}`);
  loadSources();
});

refresh();
