// Sends captures to the local FeedMerge server; holds them while the server is offline.
const SERVER = 'http://127.0.0.1:4747';
const MAX_QUEUE = 300;

let lock = Promise.resolve();
const withLock = fn => (lock = lock.then(fn, fn));

async function bump(platform, ok) {
  const { stats = {} } = await chrome.storage.local.get('stats');
  const s = stats[platform] || { sent: 0, queued: 0, last: 0 };
  ok ? s.sent++ : s.queued++;
  s.last = Date.now();
  stats[platform] = s;
  await chrome.storage.local.set({ stats });
}

async function post(cap) {
  const r = await fetch(SERVER + '/ingest', { method: 'POST', headers: { 'content-type': 'application/json', 'x-feedmerge': '1' }, body: JSON.stringify(cap) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}

// Extra accounts live in their own Chrome profiles, so no account's algorithm is muddied by
// another's interests. Each profile sends an anonymous id with its captures; FeedMerge
// merges them all into one feed and uses the id only to tell the accounts apart.
async function profileId() {
  let { profile } = await chrome.storage.local.get('profile');
  if (!profile) {
    profile = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
    await chrome.storage.local.set({ profile });
  }
  return profile;
}

async function capture(cap) {
  const { paused } = await chrome.storage.local.get('paused');
  if (paused) return;
  cap.profile = await profileId();
  try { await post(cap); await withLock(() => bump(cap.platform, true)); }
  catch {
    await withLock(async () => {
      const { queue = [] } = await chrome.storage.local.get('queue');
      queue.push(cap);
      while (queue.length > MAX_QUEUE) queue.shift();
      await chrome.storage.local.set({ queue });
      await bump(cap.platform, false);
    });
  }
}

async function flush() {
  await withLock(async () => {
    const { queue = [] } = await chrome.storage.local.get('queue');
    while (queue.length) {
      try { await post(queue[0]); queue.shift(); } catch { break; }
    }
    await chrome.storage.local.set({ queue });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'capture' && msg.cap) { capture(msg.cap); return false; }
  if (msg?.type === 'status') {
    (async () => {
      const { stats = {}, queue = [], paused = false } = await chrome.storage.local.get(['stats', 'queue', 'paused']);
      let online = false;
      try { online = (await fetch(SERVER + '/api/facets')).ok; } catch {}
      if (online && queue.length) flush();
      reply({ stats, queued: queue.length, paused, online });
    })();
    return true;
  }
  if (msg?.type === 'pause') { chrome.storage.local.set({ paused: !!msg.paused }).then(() => reply({ ok: true })); return true; }
});

// ---------- Background refresh ----------
// Loads each feed in a muted, minimized window on a jittered schedule so captures keep coming
// without you opening the sites. One feed at a time; nothing is clicked, liked or followed.
const TARGETS = {
  reddit: { url: 'https://www.reddit.com/', hours: 2 },
  youtube: { url: 'https://www.youtube.com/', hours: 3 },
  x: { url: 'https://x.com/home', hours: 3 },
  facebook: { url: 'https://www.facebook.com/', hours: 4 },
  instagram: { url: 'https://www.instagram.com/', hours: 4 },
  pinterest: { url: 'https://www.pinterest.com/', hours: 6 },
  tiktok: { url: 'https://www.tiktok.com/foryou', hours: 4 },
};
const DWELL_MS = 40_000;

async function refreshState() {
  const { refresh = {} } = await chrome.storage.local.get('refresh');
  refresh.enabled ??= true;
  refresh.quietFrom ??= 1; // no refreshes from 01:00…
  refresh.quietTo ??= 7;   // …to 07:00
  refresh.platforms ??= {};
  refresh.next ??= {};
  refresh.last ??= {};
  for (const p of Object.keys(TARGETS)) refresh.platforms[p] ??= { on: true, hours: TARGETS[p].hours };
  return refresh;
}
const saveRefresh = refresh => chrome.storage.local.set({ refresh });
const jitter = hours => hours * 3600e3 * (0.8 + Math.random() * 0.4);

async function finishOpen() {
  const { openRefresh } = await chrome.storage.local.get('openRefresh');
  if (!openRefresh) return;
  await chrome.tabs.remove(openRefresh.tabId).catch(() => {});
  await chrome.storage.local.remove('openRefresh');
}

async function openRefresh(platform) {
  const refresh = await refreshState();
  let { refreshWin } = await chrome.storage.local.get('refreshWin');
  const win = refreshWin != null ? await chrome.windows.get(refreshWin).catch(() => null) : null;
  let tab;
  if (win) tab = await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: true });
  else {
    const w = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false });
    tab = w.tabs[0];
    await chrome.storage.local.set({ refreshWin: w.id });
  }
  await chrome.tabs.update(tab.id, { muted: true, autoDiscardable: false });
  await chrome.tabs.update(tab.id, { url: TARGETS[platform].url });
  await chrome.storage.local.set({ openRefresh: { tabId: tab.id, platform, opened: Date.now() } });
  refresh.last[platform] = Date.now();
  refresh.next[platform] = Date.now() + jitter(refresh.platforms[platform].hours);
  await saveRefresh(refresh);
  setTimeout(() => chrome.tabs.sendMessage(tab.id, { type: 'fm-autoscroll', steps: 8 }).catch(() => {}), 9_000);
  setTimeout(finishOpen, DWELL_MS);
}

async function refreshTick(force) {
  const { openRefresh: open } = await chrome.storage.local.get('openRefresh');
  if (open) {
    if (Date.now() - open.opened > DWELL_MS + 15_000) await finishOpen();
    else return;
  }
  const refresh = await refreshState();
  if (!refresh.enabled && !force) return;
  const h = new Date().getHours();
  const quiet = refresh.quietFrom < refresh.quietTo ? h >= refresh.quietFrom && h < refresh.quietTo : h >= refresh.quietFrom || h < refresh.quietTo;
  if (quiet && !force) return;
  const due = Object.keys(TARGETS).filter(p => refresh.platforms[p].on && (force === p || Date.now() >= (refresh.next[p] || 0)));
  if (due.length) return openRefresh(due[0]);
  const page = await renderedDue();
  if (page) await readRendered(page);
}

// ---------- Browser-read web sources ----------
// Sites that are JavaScript apps send the server an empty page. These are opened here, in the
// same minimized window, and their headline links are read once the page has drawn itself.
// Chrome asks once per site (popup) before the extension may read it.
const RENDER_WAIT_MS = 12_000;

function collectHeadlines() {
  const host = location.host.replace(/^www\./, '');
  const seen = new Set(), out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try { u = new URL(a.href); } catch { continue; }
    if (u.host.replace(/^www\./, '') !== host || u.pathname.split('/').filter(Boolean).length < 1) continue;
    const title = (a.innerText || a.textContent || a.title || '').replace(/\s+/g, ' ').trim();
    if (title.length < 25 || title.length > 300) continue;
    u.hash = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ url: u.href, title });
    if (out.length >= 80) break;
  }
  return out;
}

async function renderedDue() {
  let list = [];
  try { list = await (await fetch(SERVER + '/api/rendered-sources')).json(); } catch { return null; }
  const needs = [];
  let due = null;
  for (const s of list) {
    const origin = new URL(s.url).origin + '/*';
    if (!(await chrome.permissions.contains({ origins: [origin] }))) { needs.push(new URL(s.url).host); continue; }
    if (!due && Date.now() >= (s.last_fetch || 0) + Math.max(60, s.interval_min || 60) * 60_000) due = s;
  }
  await chrome.storage.local.set({ renderNeeds: needs });
  return due;
}

async function readRendered(src) {
  let { refreshWin } = await chrome.storage.local.get('refreshWin');
  const win = refreshWin != null ? await chrome.windows.get(refreshWin).catch(() => null) : null;
  let tab;
  if (win) tab = await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: true });
  else {
    const w = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false });
    tab = w.tabs[0];
    await chrome.storage.local.set({ refreshWin: w.id });
  }
  await chrome.tabs.update(tab.id, { muted: true, autoDiscardable: false, url: src.url });
  await chrome.storage.local.set({ openRefresh: { tabId: tab.id, platform: 'web:' + src.id, opened: Date.now() } });
  setTimeout(async () => {
    let body;
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectHeadlines });
      body = { links: r?.result || [] };
    } catch (e) { body = { error: String(e?.message || e) }; }
    try { await fetch(SERVER + '/api/rendered-sources/' + src.id, { method: 'POST', headers: { 'content-type': 'application/json', 'x-feedmerge': '1' }, body: JSON.stringify(body) }); } catch {}
    await finishOpen();
  }, RENDER_WAIT_MS);
}

// First run: stagger the platforms a couple of minutes apart.
async function seedSchedule() {
  const refresh = await refreshState();
  Object.keys(TARGETS).forEach((p, i) => { if (!refresh.next[p] || refresh.next[p] < Date.now()) refresh.next[p] = Date.now() + (1 + i * 2) * 60_000; });
  await saveRefresh(refresh);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'refresh-state') { refreshState().then(reply); return true; }
  if (msg?.type === 'render-needs') { renderedDue().then(() => chrome.storage.local.get('renderNeeds')).then(r => reply(r.renderNeeds || [])); return true; }
  if (msg?.type === 'refresh-set') {
    (async () => {
      const r = await refreshState();
      if ('enabled' in msg) r.enabled = !!msg.enabled;
      if (msg.platform) r.platforms[msg.platform].on = !!msg.on;
      await saveRefresh(r);
      reply(r);
    })();
    return true;
  }
  if (msg?.type === 'refresh-now') {
    (async () => {
      const r = await refreshState();
      Object.keys(TARGETS).forEach((p, i) => { if (r.platforms[p].on) r.next[p] = Date.now() + i * 60_000; });
      await saveRefresh(r);
      await refreshTick(true);
      reply({ ok: true });
    })();
    return true;
  }
});

function setupAlarms() {
  chrome.alarms.create('flush', { periodInMinutes: 1 });
  chrome.alarms.create('refresh', { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(() => { setupAlarms(); seedSchedule(); });
chrome.runtime.onStartup.addListener(() => { setupAlarms(); chrome.storage.local.remove('openRefresh'); });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'flush') flush();
  if (a.name === 'refresh') refreshTick(false);
});
