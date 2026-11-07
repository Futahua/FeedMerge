const $ = s => document.querySelector(s);
const { esc, ago, short } = window.Native;
const NAMES = { web: 'Web', x: 'X', youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', threads: 'Threads', bluesky: 'Bluesky', reddit: 'Reddit' };
const POST = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-feedmerge': '1' }, body: JSON.stringify(body || {}) });

const state = { platforms: new Set(), context: '', labels: new Map(), q: '', sort: 'captured', saved: false, ads: false, review: false, offset: 0, done: false, loading: false, newest: 0 };
const items = new Map();
let cats = { layers: [], review: 0 };
try { const s = JSON.parse(localStorage.getItem('fm-view') || '{}'); if (s.sort) state.sort = s.sort; if (s.platforms) state.platforms = new Set(s.platforms); } catch {}
const remember = () => { try { localStorage.setItem('fm-view', JSON.stringify({ sort: state.sort, platforms: [...state.platforms] })); } catch {} };

function params(extra = {}) {
  const p = new URLSearchParams();
  if (state.platforms.size) p.set('platform', [...state.platforms].join(','));
  if (state.context) p.set('context', state.context);
  if (state.labels.size) p.set('label', [...state.labels.keys()].join(','));
  if (state.q) p.set('q', state.q);
  if (state.saved) p.set('saved', '1');
  if (state.ads) p.set('ads', '1');
  if (state.review) p.set('review', '1');
  p.set('sort', state.sort === 'balanced' ? 'captured' : state.sort);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

// Round-robin a page across platforms so one busy source doesn't drown the rest.
function balance(list) {
  const groups = new Map();
  for (const it of list) (groups.get(it.platform) || groups.set(it.platform, []).get(it.platform)).push(it);
  const out = [];
  const qs = [...groups.values()];
  while (out.length < list.length) for (const g of qs) if (g.length) out.push(g.shift());
  return out;
}

// ---------- The FeedMerge strip under each native card ----------
function strip(it) {
  const labs = it.labels.map(l => `<span class="lab lay-${esc(l.layer)} ${l.decided === 1 ? 'yes' : ''}" data-lab="${l.id}" title="${esc(l.layer)} · ${l.decided === 1 ? 'confirmed by you' : `${esc(l.source)} · ${Math.round(l.prob * 100)}%`}">
      <button class="nm" data-filter="${l.id}" data-name="${esc(l.name)}" data-layer="${esc(l.layer)}">${l.source === 'agent' && l.decided !== 1 ? '<span title="Suggested by an assistant">✦ </span>' : ''}${esc(l.name)}${l.decided !== 1 && l.source !== 'rule' ? `<small>${Math.round(l.prob * 100)}%</small>` : ''}</button>
      <button class="ok" data-decide="1" title="Correct">✓</button><button class="no" data-decide="-1" title="Wrong">✕</button></span>`).join('');
  return `<div class="fm-strip">${labs}<button class="add-lab" data-add title="Add a label">+</button>
    <span class="meta"><span title="${esc(NAMES[it.platform])} · ${esc(it.context || '')}">${esc(NAMES[it.platform] || it.platform)} · ${esc(it.context || '')}</span>
    ${it.seenCount > 1 ? `<span title="times the platform showed this to you">shown ${it.seenCount}×</span>` : ''}
    <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">Open</a>
    <button class="star ${it.saved ? 'on' : ''}" data-save title="Save">${it.saved ? '★' : '☆'}</button></span></div>`;
}

function renderCard(it) {
  items.set(it.id, it);
  return window.Native.render(it, strip(it));
}

async function load(reset) {
  if (state.loading || (state.done && !reset)) return;
  state.loading = true;
  if (reset) { state.offset = 0; state.done = false; $('#feed').innerHTML = ''; $('#fresh').hidden = true; items.clear(); }
  $('#more').textContent = 'Loading…';
  try {
    let list = await (await fetch('/api/items?' + params({ limit: 40, offset: state.offset }))).json();
    if (reset) state.newest = list[0]?.firstSeen || Date.now();
    state.offset += list.length;
    state.done = list.length < 40;
    if (state.sort === 'balanced') list = balance(list);
    const tmp = document.createElement('div');
    tmp.innerHTML = list.map(renderCard).join('');
    window.Native.mount(tmp);
    $('#feed').append(...tmp.children);
    if (reset && !list.length) $('#feed').innerHTML = `<div class="empty">Nothing matches. Clear a filter, or let the extension and your sources bring in more posts.</div>`;
    $('#more').textContent = state.done ? (state.offset ? 'That’s everything.' : '') : '';
  } catch (e) { $('#more').textContent = 'Server not reachable.'; }
  state.loading = false;
}

async function facets() {
  const [f, c] = await Promise.all([fetch('/api/facets').then(r => r.json()), fetch('/api/categories').then(r => r.json())]);
  cats = c;
  $('#platforms').innerHTML = f.platforms.map(p => `<button class="chip ${state.platforms.has(p.platform) ? 'on' : ''}" data-pf="${esc(p.platform)}">${esc(NAMES[p.platform] || p.platform)}<span class="n">${p.n}</span></button>`).join('') || '<span class="foot">No captures yet</span>';
  const ctx = f.contexts.filter(x => !state.platforms.size || state.platforms.has(x.platform));
  $('#contexts').innerHTML = ctx.slice(0, 12).map(x => `<button data-ctx="${esc(x.context)}" class="${state.context === x.context ? 'on' : ''}"><span>${esc(NAMES[x.platform] || x.platform)} · ${esc(x.context)}</span><span class="n">${x.n}</span></button>`).join('');
  $('#layerBoxes').innerHTML = c.layers.map(l => {
    const labs = l.labels.filter(x => x.n > 0).slice(0, l.id === 'story' ? 15 : 12);
    if (!labs.length) return '';
    return `<section><h2>${esc(l.name)}</h2><div class="list lay-${esc(l.id)}">${labs.map(x => `<button data-filter="${x.id}" data-name="${esc(x.name)}" data-layer="${esc(l.id)}" class="${state.labels.has(x.id) ? 'on' : ''}"><span><i class="dot"></i>${esc(x.name)}</span><span class="n">${x.n}${l.id === 'story' ? ` · ${x.platforms}p` : ''}</span></button>`).join('')}</div></section>`;
  }).join('');
  $('#reviewN').textContent = c.review ? `(${c.review})` : '';
  $('#status').innerHTML = [
    `<div><span>Items</span><span>${f.total.n}</span></div>`,
    `<div><span>Captures kept</span><span>${f.captures}</span></div>`,
    ...f.platforms.map(p => `<div><span>${esc(NAMES[p.platform] || p.platform)} last</span><span>${ago(p.last)} ago</span></div>`),
    `<div><span>AI provider</span><span>${f.ai.enabled ? 'on' : 'mock rules'}</span></div>`,
  ].join('');
}

function renderActive() {
  const chips = [];
  if (state.context) chips.push(`<button class="chip on" data-clear="context">From: ${esc(state.context)} ✕</button>`);
  for (const [id, l] of state.labels) chips.push(`<button class="chip on" data-unlabel="${id}">${esc(l.layer)}: ${esc(l.name)} ✕</button>`);
  if (state.review) chips.push('<button class="chip on" data-clear="review">Needs review ✕</button>');
  $('#active').innerHTML = chips.join('');
}

function refresh() { remember(); renderActive(); facets(); load(true); }

function toggleLabel(id, name, layer) {
  id = Number(id);
  state.labels.has(id) ? state.labels.delete(id) : state.labels.set(id, { name, layer });
  window.scrollTo(0, 0);
  refresh();
}

document.addEventListener('click', async e => {
  const t = e.target;
  const card = t.closest('.card.n');
  // Sidebar and active-filter controls
  const pf = t.closest('[data-pf]');
  if (pf) { state.platforms.has(pf.dataset.pf) ? state.platforms.delete(pf.dataset.pf) : state.platforms.add(pf.dataset.pf); state.context = ''; return refresh(); }
  const cx = t.closest('[data-ctx]');
  if (cx) { state.context = state.context === cx.dataset.ctx ? '' : cx.dataset.ctx; return refresh(); }
  const fl = t.closest('[data-filter]');
  if (fl) return toggleLabel(fl.dataset.filter, fl.dataset.name, fl.dataset.layer);
  const ul = t.closest('[data-unlabel]');
  if (ul) { state.labels.delete(Number(ul.dataset.unlabel)); return refresh(); }
  const cl = t.closest('[data-clear]');
  if (cl) { state[cl.dataset.clear] = cl.dataset.clear === 'review' ? false : ''; if (cl.dataset.clear === 'review') $('#review').checked = false; return refresh(); }
  if (!card) return;
  const it = items.get(card.dataset.id);
  if (!it) return;
  // Confirm / reject a label
  const dec = t.closest('[data-decide]');
  if (dec) {
    const labId = Number(dec.closest('[data-lab]').dataset.lab);
    const decided = Number(dec.dataset.decide);
    await POST(`/api/items/${encodeURIComponent(it.id)}/label`, { labelId: labId, decided });
    if (decided === -1) it.labels = it.labels.filter(l => l.id !== labId);
    else it.labels = it.labels.map(l => (l.id === labId ? { ...l, decided: 1 } : l));
    card.querySelector('.fm-strip').outerHTML = strip(it);
    return;
  }
  // Add a label to this post
  if (t.closest('[data-add]')) {
    const btn = t.closest('[data-add]');
    const layers = cats.layers.filter(l => l.id !== 'format');
    btn.outerHTML = `<form class="add-form"><select>${layers.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select><input list="lab-names" placeholder="Label" required><button>Add</button></form>`;
    let dl = document.getElementById('lab-names');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'lab-names'; document.body.append(dl); }
    dl.innerHTML = cats.layers.flatMap(l => l.labels.map(x => `<option value="${esc(x.name)}">`)).join('');
    const form = card.querySelector('.add-form');
    form.querySelector('input').focus();
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const layer = form.querySelector('select').value;
      const name = form.querySelector('input').value.trim();
      if (!name) return;
      const r = await (await POST(`/api/items/${encodeURIComponent(it.id)}/label`, { layer, name, decided: 1 })).json();
      it.labels = it.labels.filter(l => l.id !== r.labelId).concat([{ id: r.labelId, layer, name, prob: 1, source: 'user', decided: 1 }]);
      card.querySelector('.fm-strip').outerHTML = strip(it);
    });
    return;
  }
  if (t.closest('[data-save]')) {
    const b = t.closest('[data-save]');
    const on = !b.classList.contains('on');
    await POST(`/api/items/${encodeURIComponent(it.id)}/save`, { saved: on });
    it.saved = on;
    b.classList.toggle('on', on);
    b.textContent = on ? '★' : '☆';
    return;
  }
  if (window.Native.handleClick(e, it, card)) e.preventDefault();
});

let qTimer;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value.trim(); load(true); }, 250); });
$('#sort').value = state.sort;
$('#sort').addEventListener('change', e => { state.sort = e.target.value; remember(); load(true); });
$('#saved').addEventListener('change', e => { state.saved = e.target.checked; load(true); });
$('#ads').addEventListener('change', e => { state.ads = e.target.checked; load(true); });
$('#review').addEventListener('change', e => { state.review = e.target.checked; renderActive(); load(true); });
$('#menu').addEventListener('click', () => $('#side').classList.toggle('open'));
$('#fresh').addEventListener('click', () => { window.scrollTo(0, 0); refresh(); });
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { b.closest('dialog').close(); refresh(); }));

new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) load(false); }, { rootMargin: '1200px' }).observe($('#more'));

setInterval(async () => {
  if (document.hidden || state.sort === 'published' || state.sort === 'repeated') return;
  try {
    const list = await (await fetch('/api/items?' + params({ limit: 200, since: state.newest }))).json();
    $('#fresh').hidden = !list.length;
    $('#fresh').textContent = `${list.length}${list.length === 200 ? '+' : ''} new posts — show`;
  } catch {}
}, 20000);
setInterval(() => { if (!document.hidden) facets(); }, 60000);

// ---------- Web sources dialog ----------
async function loadSources() {
  const list = await (await fetch('/api/sources')).json();
  $('#srcList').innerHTML = list.length ? list.map(s => `<div class="src ${s.enabled ? '' : 'off'}" data-src="${s.id}">
      <div class="nm">${esc(s.name)}</div>
      <div class="acts"><button class="btn" data-src-act="refresh">Refresh</button><button class="btn" data-src-act="toggle">${s.enabled ? 'Pause' : 'Resume'}</button><button class="btn" data-src-act="delete">Remove</button></div>
      <div class="sub">${s.kind === 'page' ? 'Watched page' : 'Feed'} · every ${s.interval_min} min · ${s.items} items · checked ${s.last_fetch ? ago(s.last_fetch) + ' ago' : 'never'}</div>
      <div class="sub">${esc(s.url)}</div>
      ${s.last_error ? `<div class="err">Last check failed: ${esc(s.last_error)}</div>` : ''}
    </div>`).join('') : '<p class="hint">No web sources yet.</p>';
}
$('#sourcesBtn').addEventListener('click', () => { $('#sourcesDlg').showModal(); loadSources(); });
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
  b.disabled = true;
  await POST(`/api/sources/${b.closest('[data-src]').dataset.src}/${b.dataset.srcAct}`);
  loadSources();
});

// ---------- Categories dialog ----------
let catLayer = 'topic';
async function loadCats() {
  cats = await (await fetch('/api/categories')).json();
  $('#catTabs').innerHTML = cats.layers.map(l => `<button class="tab ${l.id === catLayer ? 'on' : ''}" data-tab="${l.id}">${esc(l.name)}</button>`).join('');
  const layer = cats.layers.find(l => l.id === catLayer);
  $('#addLabel').hidden = catLayer === 'format' || catLayer === 'story';
  $('#catList').innerHTML = (layer?.labels || []).map(x => `<div class="cat lay-${esc(catLayer)}" data-cat="${x.id}">
      <div class="cat-top"><i class="dot"></i><input class="cat-name" value="${esc(x.name)}"><span class="src-tag">${esc(x.source)}</span><span class="n">${x.n} posts</span>
      <button class="btn" data-cat-save>Save</button><button class="btn" data-cat-del>Delete</button></div>
      ${catLayer === 'format' || catLayer === 'story' ? '' : `<input class="cat-kw" placeholder="Keywords, comma separated" value="${esc((x.keywords || []).join(', '))}">`}
    </div>`).join('') || '<p class="hint">No labels in this layer yet.</p>';
}
$('#catsBtn').addEventListener('click', () => { $('#catsDlg').showModal(); loadCats(); });
$('#catTabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { catLayer = b.dataset.tab; loadCats(); } });
$('#addLabel').addEventListener('submit', async e => {
  e.preventDefault();
  const kw = $('#newLabelKw').value.split(',').map(s => s.trim()).filter(Boolean);
  await POST('/api/labels', { layer: catLayer, name: $('#newLabelName').value.trim(), keywords: kw });
  $('#newLabelName').value = ''; $('#newLabelKw').value = '';
  loadCats();
});
$('#catList').addEventListener('click', async e => {
  const row = e.target.closest('[data-cat]');
  if (!row) return;
  const id = Number(row.dataset.cat);
  if (e.target.closest('[data-cat-del]')) { if (confirm('Delete this label and remove it from every post?')) { await POST(`/api/labels/${id}/delete`); loadCats(); } }
  if (e.target.closest('[data-cat-save]')) {
    const kwEl = row.querySelector('.cat-kw');
    await POST('/api/labels', { id, name: row.querySelector('.cat-name').value.trim(), keywords: kwEl ? kwEl.value.split(',').map(s => s.trim()).filter(Boolean) : undefined });
    e.target.textContent = 'Saved';
  }
});

refresh();
