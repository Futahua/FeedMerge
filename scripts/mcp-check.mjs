// Connects to a FeedMerge MCP endpoint like a remote assistant would, lists tools and calls two.
// Usage: node scripts/mcp-check.mjs <url>   (reads the URL from public-url.txt if omitted)
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] || fs.readFileSync('D:/Programs/MCPGateway/public-url.txt', 'utf8').match(/https:\S+feedmerge\/mcp/)[0];
const shown = url.replace(/\/[A-Za-z0-9_-]{20,}\//, '/<secret>/');
const client = new Client({ name: 'feedmerge-check', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const { tools } = await client.listTools();
console.log(shown, '→ tools:', tools.map(t => t.name).join(', '));
const ov = await client.callTool({ name: 'feed_overview', arguments: {} });
const o = JSON.parse(ov.content[0].text);
console.log('feed_overview: posts', o.total_posts, '| platforms', JSON.stringify(o.platforms), '| provider', o.ai_provider);
const sp = await client.callTool({ name: 'search_posts', arguments: { query: 'Hanoi', limit: 2 } });
console.log('search_posts("Hanoi"):', sp.content[0].text.split('\n\n')[1].slice(0, 300).replace(/\s+/g, ' '));
await client.close();
