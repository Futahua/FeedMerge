// Read-only acceptance against the existing gateway. Does not print capability URLs.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client=new Client({name:'feedmerge-controls-check',version:'1'});
try {
 await client.connect(new StreamableHTTPClientTransport(new URL(process.argv[2]||'http://127.0.0.1:8790/feedmerge/mcp')));
 const tools=(await client.listTools()).tools;
 for(const name of ['inspect_source','test_source_rules','configure_source_extraction','request_source_capture','get_control_catalog','configure_backend','request_backend_job'])if(!tools.some(t=>t.name===name))throw Error(`Missing tool: ${name}`);
 const r=await client.callTool({name:'get_control_catalog',arguments:{}});
 if(r.isError)throw Error('Control catalog call failed.');
 const catalog=JSON.parse(r.content[0].text);
 if(catalog.controls.length<60)throw Error('Incomplete control catalog.');
 const status=await client.callTool({name:'get_ingestion_status',arguments:{}});
 if(status.isError)throw Error('Ingestion status call failed.');
 console.log(JSON.stringify({transport:'HTTP MCP',tools:tools.length,controls:catalog.controls.length,catalog:'ok',ingestion_status:'ok',mutations:0}));
} finally {await client.close();}
