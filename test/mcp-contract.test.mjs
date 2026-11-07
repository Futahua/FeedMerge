import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

test('taxonomy tools preview without writes, require explicit apply, and carry rename preconditions', async () => {
  const writes = [];
  const api = createServer(async (req, res) => {
    if (req.method === 'POST') {
      let text = ''; for await (const chunk of req) text += chunk;
      writes.push(JSON.parse(text));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { layers: [{ id: 'story', labels: [{ id: 1, name: 'Original story' }] }] } : { ok: true }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'isolated-contract-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../mcp.mjs', import.meta.url))],
    env: { ...process.env, FEEDMERGE_URL: `http://127.0.0.1:${api.address().port}` }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    await client.callTool({ name: 'propose_label', arguments: { layer: 'topic', name: 'New topic' } });
    await client.callTool({ name: 'rename_story', arguments: { label_id: 1, name: 'Updated story' } });
    assert.equal(writes.length, 0);
    const refused = await client.callTool({ name: 'rename_story', arguments: { label_id: 1, name: 'Updated story', apply: true } });
    assert.equal(refused.isError, true);
    assert.equal(writes.length, 0);
    await client.callTool({ name: 'rename_story', arguments: { label_id: 1, name: 'Updated story', apply: true, expected_name: 'Original story' } });
    assert.deepEqual(writes, [{ id: 1, name: 'Updated story', source: 'agent', expectedName: 'Original story' }]);
    await client.callTool({ name: 'propose_label', arguments: { layer: 'topic', name: 'New topic', apply: true } });
    assert.equal(writes.length, 2);
    assert.equal(writes[1].source, 'agent');
  } finally {
    await client.close();
    await new Promise(resolve => api.close(resolve));
  }
});
