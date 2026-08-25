
    import fs from 'node:fs';
    import { Server } from '@modelcontextprotocol/server';
    import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
    const inputSchema = {
      type: 'object',
      required: ['value'],
      additionalProperties: false,
      properties: { value: { type: 'string', minLength: 2 } },
    };
    const server = new Server({ name: 'mock-call-gate', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        { name: 'echo', description: 'Echo validated text.', inputSchema },
        { name: 'upper', description: 'Uppercase validated text.', inputSchema },
        { name: 'unsupported', description: 'Expose an unsupported schema dialect.', inputSchema: { '$schema': 'urn:unsupported', type: 'object' } },
      ],
    }));
    server.setRequestHandler('tools/call', async (request) => {
      fs.appendFileSync("/Users/bgaryy/code/octocode-agent/packages/octocode-pi-extension/.tmp-mcp-call-gate-wgF9FW/called.ndjson", JSON.stringify(request.params) + '\n');
      const value = request.params.arguments?.value;
      return { content: [{ type: 'text', text: request.params.name === 'upper' ? String(value).toUpperCase() : 'echo:' + value }] };
    });
    await server.connect(new StdioServerTransport());
  