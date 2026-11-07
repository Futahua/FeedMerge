# FeedMerge

Your platforms' recommendation feeds, merged into one local page. You keep scrolling X, YouTube, TikTok, Instagram, Threads, Bluesky and Reddit as usual, so each algorithm keeps learning from you. A Chrome extension quietly saves what each feed shows you, and http://127.0.0.1:4747 shows it all in one place.

## Parts
- `extension/`: Chrome extension. It copies the feed data each site already downloads (Reddit is read from the page itself). It never clicks, likes, follows or posts anything.
- `server.mjs`: local store on 127.0.0.1:4747. It keeps every raw capture in `data/feed.db` and builds feed items from them.
- `parsers.mjs`: one parser per platform. When a site changes or a parser improves, run a reparse: `POST /api/reparse` with header `x-feedmerge: 1`. That rebuilds every item from the kept raw captures, and your saves and AI labels are kept.
- `viewer/`: the merged feed. You can filter by platform, by where a post came from (for-you, following, home, up-next…), by topic or by story. It has full-text search, and four orders: newest, balanced across platforms, newest posted, and "pushed to you most often".
- `ai.mjs`: optional topic and cross-platform story labels through any OpenAI-compatible API. It's off by default and runs in the background.

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

## Limits
- It only sees what your Chrome sessions load. The TikTok and Instagram phone apps aren't captured.
- Facebook and LinkedIn aren't supported.
- Capturing your own signed-in feeds may break a platform's terms. It only stores what you were shown, on your own computer.
