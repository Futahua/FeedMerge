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

async function capture(cap) {
  const { paused } = await chrome.storage.local.get('paused');
  if (paused) return;
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
  if (due.length) await openRefresh(due[0]);
}

// First run: stagger the platforms a couple of minutes apart.
async function seedSchedule() {
  const refresh = await refreshState();
  Object.keys(TARGETS).forEach((p, i) => { if (!refresh.next[p] || refresh.next[p] < Date.now()) refresh.next[p] = Date.now() + (1 + i * 2) * 60_000; });
  await saveRefresh(refresh);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'refresh-state') { refreshState().then(reply); return true; }
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
