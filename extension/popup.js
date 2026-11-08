const ago = t => { if (!t) return 'never'; const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

async function render() {
  const st = await chrome.runtime.sendMessage({ type: 'status' });
  document.getElementById('srv').innerHTML = `<span class="dot ${st.online ? 'on' : ''}"></span>${st.online ? 'server on' : 'server off'}`;
  document.getElementById('note').textContent = st.queued ? `${st.queued} captures waiting for the server` : st.paused ? 'Capture is paused' : 'Capturing while you scroll';
  const rows = Object.entries(st.stats).sort((a, b) => b[1].last - a[1].last);
  document.getElementById('t').innerHTML = rows.length
    ? rows.map(([p, s]) => `<tr><td>${p}</td><td class="n">${s.sent} sent · ${ago(s.last)}</td></tr>`).join('')
    : '<tr><td class="muted">Nothing captured yet. Scroll a feed.</td></tr>';
  const b = document.getElementById('pause');
  b.textContent = st.paused ? 'Resume capture' : 'Pause capture';
  b.onclick = async () => { await chrome.runtime.sendMessage({ type: 'pause', paused: !st.paused }); render(); };
}

const until = t => { if (!t) return '—'; const s = (t - Date.now()) / 1000; return s <= 60 ? 'soon' : s < 3600 ? `in ${Math.round(s / 60)} min` : `in ${(s / 3600).toFixed(1)} h`; };

async function renderRefresh() {
  const r = await chrome.runtime.sendMessage({ type: 'refresh-state' });
  document.getElementById('rfOn').checked = r.enabled;
  document.getElementById('rf').innerHTML = Object.entries(r.platforms).map(([p, c]) =>
    `<tr><td><label><input type="checkbox" data-p="${p}" ${c.on ? 'checked' : ''}> ${p}</label></td><td class="n">${c.on && r.enabled ? until(r.next[p]) : 'off'} · last ${ago(r.last[p])}</td></tr>`).join('');
}
document.getElementById('rfOn').onchange = async e => { await chrome.runtime.sendMessage({ type: 'refresh-set', enabled: e.target.checked }); renderRefresh(); };
document.getElementById('rf').onchange = async e => { const p = e.target.dataset.p; if (p) { await chrome.runtime.sendMessage({ type: 'refresh-set', platform: p, on: e.target.checked }); renderRefresh(); } };
document.getElementById('rfNow').onclick = async e => { e.target.disabled = true; e.target.textContent = 'Started — one feed per minute'; await chrome.runtime.sendMessage({ type: 'refresh-now' }); renderRefresh(); };
renderRefresh();

// Sites added in FeedMerge that only a browser can read. One Allow covers every website, so
// sources added later need no further approval; only the sites added as sources are read.
const ALL_SITES = ['https://*/*', 'http://*/*'];
chrome.runtime.sendMessage({ type: 'render-needs' }).then(hosts => {
  if (!hosts?.length) return;
  const box = document.getElementById('access');
  box.innerHTML = `<div class="muted" style="margin-top:8px">These sources are apps only a browser can read: <b></b>. Allow once and FeedMerge can read any source you add, now or later.</div><button class="primary">Allow</button>`;
  box.querySelector('b').textContent = hosts.join(', ');
  box.querySelector('button').onclick = async () => {
    const ok = await chrome.permissions.request({ origins: ALL_SITES });
    box.innerHTML = `<div class="muted" style="margin-top:8px">${ok ? 'Allowed. They are read on the next background refresh.' : 'Not allowed.'}</div>`;
  };
});

document.getElementById('open').onclick = () => chrome.tabs.create({ url: 'http://127.0.0.1:4747/' });
render();
