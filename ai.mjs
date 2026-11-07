// Optional topic + story labelling through any OpenAI-compatible chat API (Gemini, Groq,
// OpenRouter, ...). Runs in the background; capture and viewing never wait for it.
const SYSTEM = `You label social media posts for a personal merged feed.
For each item return:
- "topics": 1-3 short topic labels (1-4 words, Title Case, broad enough to recur, e.g. "AI Models", "Architecture", "Formula 1"). Reuse labels from existingTopics whenever one fits.
- "story": if the item is about a specific event, release, announcement or news story that other posts are likely discussing too, a short neutral label for that story (max 8 words). Reuse a label from recentStories exactly when it is the same story. Otherwise null.
Reply with JSON only: {"items":[{"id":"...","topics":["..."],"story":null}]}`;

export function startTagger(db, readConfig, log) {
  let backoff = 0;
  let badTries = 0;
  const later = ms => setTimeout(tick, ms).unref?.();

  async function tick() {
    const cfg = readConfig().ai || {};
    const key = cfg.apiKey || process.env.FEEDMERGE_AI_KEY;
    const every = (Number(cfg.intervalSeconds) || 20) * 1000;
    if (!cfg.enabled || !key || !cfg.baseUrl || !cfg.model) return later(60_000);
    const rows = db.prepare('select id, platform, author, title, text from items where ai_done = 0 order by first_seen desc limit ?').all(Number(cfg.batchSize) || 25);
    if (!rows.length) return later(Math.max(every, 30_000));
    try {
      const topics = db.prepare('select value t, count(*) n from items, json_each(items.ai_topics) group by value order by n desc limit 80').all().map(r => r.t);
      const stories = db.prepare('select ai_story s, count(*) n from items where ai_story is not null and first_seen > ? group by ai_story order by n desc limit 60').all(Date.now() - 4 * 864e5).map(r => r.s);
      const payload = {
        existingTopics: topics,
        recentStories: stories,
        items: rows.map(r => ({ id: r.id, platform: r.platform, author: r.author, text: `${r.title ? r.title + '\n' : ''}${r.text || ''}`.slice(0, 700) })),
      };
      const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: cfg.model, temperature: 0.2, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(payload) }] }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
      const body = await res.json();
      const content = String(body.choices?.[0]?.message?.content || '');
      const json = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
      const byId = new Map((json.items || []).map(x => [x.id, x]));
      const upd = db.prepare('update items set ai_topics = ?, ai_story = ?, ai_done = 1 where id = ?');
      db.exec('begin');
      for (const r of rows) {
        const x = byId.get(r.id);
        const t = Array.isArray(x?.topics) ? x.topics.filter(v => typeof v === 'string').slice(0, 3) : [];
        upd.run(JSON.stringify(t), typeof x?.story === 'string' && x.story.trim() ? x.story.trim() : null, r.id);
      }
      db.exec('commit');
      backoff = 0;
      badTries = 0;
      log('ai labelled', rows.length);
      later(every);
    } catch (e) {
      // A batch that keeps failing for a non-transient reason (bad JSON, 400) is skipped after 3 tries.
      const transient = !e.status || e.status === 429 || e.status >= 500;
      if (!transient || e instanceof SyntaxError) {
        badTries++;
        if (badTries >= 3) {
          const skip = db.prepare('update items set ai_done = 2 where id = ?');
          for (const r of rows) skip.run(r.id);
          badTries = 0;
          log('ai skipped a batch after 3 failures:', e.message);
          return later(every);
        }
      }
      backoff = Math.min(backoff ? backoff * 2 : every * 2, 15 * 60_000);
      log('ai error', e.message, `retry in ${Math.round(backoff / 1000)}s`);
      later(backoff);
    }
  }

  later(5_000);
}
