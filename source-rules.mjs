// Declarative headline extraction only. No scripts, regular expressions or credentials.
export function normalizeRules(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Rules must be an object.');
  const allowed = new Set(['minTitleLength', 'maxTitleLength', 'includePaths', 'excludePaths', 'linkSelector']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw Error(`Unknown extraction rule: ${key}`);
  const minTitleLength = value.minTitleLength ?? 25, maxTitleLength = value.maxTitleLength ?? 300;
  if (!Number.isInteger(minTitleLength) || !Number.isInteger(maxTitleLength) || minTitleLength < 3 || maxTitleLength > 500 || minTitleLength > maxTitleLength) throw Error('Title limits must be integers between 3 and 500.');
  const paths = key => {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.length > 20 || list.some(p => typeof p !== 'string' || !p.startsWith('/') || p.length > 200 || /[\r\n]/.test(p))) throw Error(`Invalid ${key}. Use up to 20 path prefixes.`);
    return [...new Set(list)];
  };
  const linkSelector = value.linkSelector ?? 'a[href]';
  // Restrict to a small CSS subset: descendants/children, tags, classes, IDs, [href].
  // No pseudo-classes, attribute values, script execution or unbounded regexes.
  if (typeof linkSelector !== 'string' || linkSelector.length > 160 || !/^[\w\s.#>\-\[\]]+$/.test(linkSelector) || /\[(?!href\])/.test(linkSelector)) throw Error('Use a simple link selector, e.g. main .story a[href].');
  return {minTitleLength, maxTitleLength, includePaths: paths('includePaths'), excludePaths: paths('excludePaths'), linkSelector};
}

export function filterSourceLinks(links, base, rules = {}) {
  const r = normalizeRules(rules), origin = new URL(base), seen = new Set(), out = [];
  for (const link of links) {
    let u; try { u = new URL(link.url, base); } catch { continue; }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.host.replace(/^www\./, '') !== origin.host.replace(/^www\./, '') || !u.pathname.split('/').filter(Boolean).length) continue;
    const title = String(link.title || '').replace(/\s+/g, ' ').trim();
    if (title.length < r.minTitleLength || title.length > r.maxTitleLength || r.includePaths.length && !r.includePaths.some(p => u.pathname.startsWith(p)) || r.excludePaths.some(p => u.pathname.startsWith(p))) continue;
    u.hash = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href); out.push({url: u.href, title});
    if (out.length >= 80) break;
  }
  return out;
}
