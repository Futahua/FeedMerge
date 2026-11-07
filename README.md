# FeedMerge

Your platforms' recommendation feeds, merged into one local page. You keep scrolling X, YouTube, TikTok, Instagram, Threads, Bluesky and Reddit as usual, so each algorithm keeps learning from you. A Chrome extension quietly saves what each feed shows you, and http://127.0.0.1:4747 shows it all in one place.

## Parts
- `extension/`: Chrome extension. It copies the feed data each site already downloads (Reddit is read from the page itself). It never clicks, likes, follows or posts anything.
- `server.mjs`: local store on 127.0.0.1:4747. It keeps every raw capture in `data/feed.db` and builds feed items from them.
- `parsers.mjs`: one parser per platform. When a site changes or a parser improves, run a reparse: `POST /api/reparse` with header `x-feedmerge: 1`. That rebuilds every item from the kept raw captures, and your saves and AI labels are kept.
- `viewer/`: the merged feed. You can filter by platform, by where a post came from (for-you, following, home, up-next…), by topic or by story. It has full-text search, and four orders: newest, balanced across platforms, newest posted, and "pushed to you most often".
- `viewer/native.js` and `native.css`: each post is drawn the way its own site draws it (X, Reddit, YouTube, TikTok, Instagram, Threads, Bluesky, articles), with that site's colors in light and dark mode. Videos from X and Instagram play inline, muted until you tap. "Play" and "View … here" swap in the platform's official player or embed. Instagram and TikTok images go through a local cache (`/media`), because their links expire and Instagram avatars refuse other sites.
- `categorize.mjs`: category layers (Topics, Stories, Places, People & orgs, Format). A mock provider fills them for now: keyword rules for Topics, Places and People; Stories group posts that share distinctive words over 4 days. You can confirm (✓), reject (✕) or add labels on any post, and edit labels and keywords under **Categories**. Your decisions are never overwritten. An AI provider will later write into the same tables.
- `ai.mjs`: optional topic and story labels through any OpenAI-compatible API, written into the category layers. It's off by default and runs in the background.

## Web sources (no browser needed)
In the viewer, click **Sources** and paste one of these:
- a site address (its feed is found automatically; sites with no feed are watched for new headlines),
- a feed link,
- a plain topic (it becomes a Google News search, in English or Vietnamese),
- an RSSHub route starting with `/`, e.g. `/telegram/channel/<name>`. Routes are listed at docs.rsshub.app.

The server polls each source itself, every 30 min for feeds and 60 min for watched pages.

RSSHub routes need a local RSSHub on 127.0.0.1:1200 (or set `"rsshub"` in `config.json` to another instance). To install it: `git clone https://github.com/DIYgod/RSSHub`, then `pnpm i`, `pnpm build`, and `pnpm start` with `LISTEN_INADDR_ANY=0` in its `.env`.

Reddit RSS feeds stop on 13 Nov 2026, so Reddit comes in through the extension only.

## Background refresh (extension)
The extension loads Reddit (every 2 h), YouTube and X (3 h), and Instagram and TikTok (4 h) in a muted, minimized window. Each interval varies by ±20%, and nothing runs between 01:00 and 07:00. Each feed is loaded for 40 s with a few scrolls, then closed. Nothing is clicked or liked. You can turn platforms on or off in the extension's popup. Chrome must be running; the extension's `background` permission lets Chrome keep running in the background after you close its windows.

## Assistants (MCP)
`mcp.mjs` is a stdio MCP server, so Claude, ChatGPT or any MCP client can work with your feed. Its tools:
- read: `feed_overview`, `search_posts`, `list_labels`
- suggest: `suggest_labels`, `propose_label`, `rename_story`

Post-label assignments from `suggest_labels` are pending suggestions and preserve confirmed/rejected decisions. A previously unknown name creates an agent-origin taxonomy label immediately. `propose_label` and `rename_story` return previews by default; `apply=true` makes an authorized, immediate taxonomy edit, not a pending suggestion. Renames also require the preview's `expected_name` and refuse concurrent changes. Nothing can be deleted through MCP. It only talks to the local FeedMerge API.

To use it from web assistants, serve it over HTTP with [Supergateway](https://github.com/supercorp-ai/supergateway) (`--config` with an `mcpServers` entry running `node mcp.mjs`). Put it behind HTTPS, for example with `tailscale funnel --bg --set-path /<long-random-secret> http://127.0.0.1:<port>`, and add `https://<host>/<secret>/feedmerge/mcp` as a connector with no authentication. The secret path is the only protection, so treat the URL like a password.

Reparse now commits the rebuilt items and full-text index together, restoring saved and classifier state. A corrupt capture, parser exception or missing previously stored post refuses the rebuild and rolls it back. Raw captures and label decisions stay intact. It remains a synchronous rebuild; large stores need a staged-job implementation before exposing it as an agent bulk operation.

Run `node --test test/*.test.mjs` for isolated rollback and MCP preview-contract checks. These do not modify the live database or call an AI provider.

Management tools now include `get_post`, `get_ingestion_status`, `list_sources`, `update_post_labels`, `mark_posts_reviewed`, `merge_stories`, `reclassify_posts`, `save_posts`, `manage_source`, `feed_change_history` and `undo_feed_change`. Search also exposes pagination and existing multi-label, saved, context, ad and sort filters.

Management edits first return a 15-minute preview. Applying its ID atomically checks the affected rows and records an idempotent receipt in the same SQLite database. Undo targets one receipt and refuses intervening edits. Marking reviewed does not confirm guessed labels. Story merge retains original IDs as aliases and refuses conflicting manual membership decisions. Reclassification queues the existing workers; manual decisions remain, but provider work is not reversible through the queue receipt. Source refresh uses the existing poller; removing a source keeps its captured posts. Undo restores source configuration, not a historical network fetch.

Source discovery, redirects and later polling share bounded, DNS-pinned destination checks. Private destinations are refused except the configured trusted RSSHub origin. A redirect does not inherit permission to reach another private service. `config.json` can disable connector writes with `agent.writes=false`; public connector access still depends on protecting its existing secret URL. No account passwords or browser sessions are exposed by these tools.

## Setup
1. Install Node.js 22.5 or newer (the server uses Node's built-in SQLite). Run `npm install`, then `node server.mjs`. To keep it running, start it at logon with a scheduled task or a startup shortcut.
2. Load the extension: open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `extension` folder.
3. Reload any feed tabs that are already open, then scroll. The extension's popup shows per-platform counts.

## AI labels (optional, free tier)
Edit `config.json`. It's re-read every cycle, so there's no need to restart.
- **Gemini** (the default endpoint): create a key at aistudio.google.com, set `"enabled": true` and `"apiKey"`.
- **Groq**: `baseUrl` `https://api.groq.com/openai/v1`, plus a Groq model name.
- **OpenRouter**: `baseUrl` `https://openrouter.ai/api/v1`, with a model ending in `:free`.

Batches of 25 posts, one call per 20 s by default. The AI only adds labels; the feed itself never depends on it.

## On your phone

FeedMerge is served inside your tailnet (not the public internet) at `https://sloptop.taild88607.ts.net:8447`
by `tailscale serve --bg --https=8447 http://127.0.0.1:4747`. The server only answers Host names it knows:
`config.json` `"hosts": ["sloptop.taild88607.ts.net:8447"]` adds that one. Writes still need the viewer's
`x-feedmerge` header. Turn it off with `tailscale serve --https=8447 off`.

The viewer has no top bar: name, search, order, Categories, Sources and every filter live in a sidebar drawer
on every screen. ☰ opens it; ✕, a tap outside, Escape or Back close it. Posts sit in a packed grid that follows Flow's smart box rule: a card takes the shape
of what it shows (wide media spans 2–3 columns, tall video and text stay one), media is never taller than 70% of
the window, and tiles pack densely so gaps fill across and down. On a PC, Ctrl+scroll zooms the grid; cards
animate to their new size and place. Cards keep balanced proportions: one
much taller than wide (over 1.6×) widens a column at a time, up to three, while that helps. Label chips are compact
(format chips are left to the sidebar; ✓/✕ show on a chip under the pointer), and with a mouse the footer, "+"
and "View … here" appear only while a card is hovered. General web pages show only the site icon, the shorter of the site's name
or address, and the title.

## Staying current (retention)

FeedMerge is for keeping up, not for hoarding. Hourly (and 30 s after start) `retention.mjs`:

- deletes a post nobody engaged with once no feed has shown it for **7 days** (counted from when a feed last
  showed it, so posts the algorithms keep pushing stay while they are current);
- keeps the **library** forever: saved posts, posts in a collection, posts with a label you confirmed (✓);
- never stores, and removes, posts captured while you navigate (a thread's replies, a profile, a search):
  only what feeds push to you counts;
- deletes ads after **1 day** and raw captures after **3 days** (reparse rebuilds the posts those cover and
  keeps older posts unchanged).

A deleted post leaves nothing behind: labels, embedding, story links, review marks and its search entry go too.
Change the windows with `POST /api/retention {"days": 14, "rawDays": 3, "adDays": 1}`; `GET /api/retention`
shows the settings and the last run. AI labeling and embeddings only spend budget on posts shown in the last
2 days. The viewer marks posts that arrived since your last visit (a visit ends after 30 minutes away).

## Backup

The scheduled task "FeedMerge backup" runs `scripts/backup.mjs` hourly (and at logon). It takes a consistent
copy of `data/feed.db` with SQLite's `VACUUM INTO` while FeedMerge keeps running, checks it with
`PRAGMA integrity_check`, and stores it gzipped in `D:\Programs\FeedMergeBackups\hourly\<time>` (48 hourly +
30 daily, about 9 MB each). The image cache (`data/media`, whose source links expire) is mirrored to
`D:\Programs\FeedMergeBackups\media`. Log: `D:\Programs\FeedMergeBackups\backup.log`.

To restore: stop FeedMerge, gunzip a copy over `data/feed.db`, delete `feed.db-wal` and `feed.db-shm`, and
copy `media` back into `data/media`. Both copies live on SlopTop's own disk: they cover a bad reparse or a
damaged database, not losing the disk.

## Limits
- It only sees what your Chrome sessions load. The TikTok and Instagram phone apps aren't captured.
- Facebook and LinkedIn aren't supported.
- Capturing your own signed-in feeds may break a platform's terms. It only stores what you were shown, on your own computer.


The connector exposes 22 actions. `edit_taxonomy_label`, `create_story`, and `split_story` use the same preview/apply/targeted-undo owner. Splits move explicit memberships into a new stable story ID and retain original captures. Taxonomy edits preserve existing post decisions and do not implicitly queue reclassification. `list_collections` and `manage_collection` maintain named collections of original post IDs in the existing SQLite store; removing a collection never removes posts. Later changes invalidate scoped undo.
