import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, type Tool } from '@modelcontextprotocol/client';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isRecord } from './util.js';

/**
 * The host side of MCP: what Octocode offers servers. Servers may ask for the
 * workspace root, ask the user for input (elicitation) and, with the user's
 * approval, borrow the active model (sampling). Tool-list changes are refreshed
 * by the SDK and reported through `onToolsChanged`.
 */
export function createMcpClient(server: string, getCtx: () => ExtensionContext | undefined, onToolsChanged: (tools: Tool[]) => void): Client {
  const client = new Client(
    { name: 'octocode-pi', version: '1.0.0' },
    {
      capabilities: { roots: {}, elicitation: { form: {}, url: {} }, sampling: {} },
      listChanged: { tools: { onChanged: (error, tools) => !error && tools && onToolsChanged(tools) } },
      inputRequired: { autoFulfill: true },
    },
  );

  client.setRequestHandler('roots/list', async () => {
    const cwd = getCtx()?.cwd;
    return { roots: cwd ? [{ uri: pathToFileURL(path.resolve(cwd)).href, name: path.basename(cwd) || 'workspace' }] : [] };
  });

  client.setRequestHandler('elicitation/create', async (request, extra) => {
    const ctx = getCtx();
    if (!ctx?.hasUI) return { action: 'decline' as const };
    return elicit(ctx, server, request.params as Record<string, unknown>, extra.mcpReq.signal);
  });

  client.setRequestHandler('sampling/createMessage', async (request, extra) => {
    const ctx = getCtx();
    const signal = extra.mcpReq.signal;
    const params = request.params as Record<string, unknown>;
    if (!ctx?.hasUI || !ctx.model) throw new Error(`MCP ${server}: sampling needs an interactive session with a model`);
    const prompt = samplingTranscript(params['messages']);
    const approved = await ctx.ui.confirm(`${server} wants to use your model`, `${prompt.slice(0, 1_200)}\n\nAllow this request?`, { signal });
    if (!approved) throw new Error(`MCP ${server}: sampling declined by the user`);
    const maxTokens = typeof params['maxTokens'] === 'number' && params['maxTokens'] > 0 ? Math.floor(params['maxTokens']) : 1_024;
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      {
        ...(typeof params['systemPrompt'] === 'string' ? { systemPrompt: params['systemPrompt'] } : {}),
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      },
      { signal, maxTokens },
    );
    const text = response.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    return {
      role: 'assistant' as const,
      content: { type: 'text' as const, text },
      model: ctx.model.id,
      stopReason: response.stopReason === 'length' ? 'maxTokens' : 'endTurn',
    };
  });

  return client;
}

function samplingTranscript(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  return messages
    .filter(isRecord)
    .map((message) => {
      const content = Array.isArray(message['content']) ? message['content'] : [message['content']];
      const text = content.filter(isRecord).map((part) => (part['type'] === 'text' ? String(part['text'] ?? '') : `[${String(part['type'])}]`)).join('\n');
      return `${String(message['role'] ?? 'user')}: ${text}`;
    })
    .join('\n\n');
}

type ElicitResult = { action: 'accept'; content?: Record<string, string | number | boolean | string[]> } | { action: 'decline' | 'cancel' };

/** Ask for each requested field with Pi's dialogs; Esc anywhere cancels the whole request. */
export async function elicit(ctx: ExtensionContext, server: string, params: Record<string, unknown>, signal: AbortSignal): Promise<ElicitResult> {
  const message = typeof params['message'] === 'string' ? params['message'] : 'The server needs input.';
  if (params['mode'] === 'url') {
    const url = String(params['url'] ?? '');
    const ok = await ctx.ui.confirm(`${server}: ${message}`, `Open this URL to continue:\n${url}`, { signal });
    if (ok) ctx.ui.notify(`Open: ${url}`, 'info');
    return { action: ok ? 'accept' : 'decline' };
  }
  const schema = isRecord(params['requestedSchema']) ? params['requestedSchema'] : {};
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [key, raw] of Object.entries(properties)) {
    const field = isRecord(raw) ? raw : {};
    const title = `${server}: ${message}\n${String(field['title'] ?? key)}${field['description'] ? ` — ${String(field['description'])}` : ''}`;
    const options = enumOptions(field);
    let answer: string | undefined;
    if (field['type'] === 'boolean') answer = await ctx.ui.select(title, ['Yes', 'No'], { signal });
    else if (options.length > 0) answer = await ctx.ui.select(title, options, { signal });
    else answer = await ctx.ui.input(title, field['default'] !== undefined ? String(field['default']) : undefined, { signal });
    if (answer === undefined) return { action: 'cancel' };
    if (field['type'] === 'boolean') content[key] = answer === 'Yes';
    else if (field['type'] === 'number' || field['type'] === 'integer') content[key] = Number(answer);
    else content[key] = answer;
  }
  return { action: 'accept', content };
}

function enumOptions(field: Record<string, unknown>): string[] {
  if (Array.isArray(field['enum'])) return field['enum'].map(String);
  if (Array.isArray(field['oneOf'])) return field['oneOf'].filter(isRecord).map((option) => String(option['const'] ?? option['title'] ?? ''));
  return [];
}

/** Hints from tool annotations that change how the model should treat a tool. */
export function annotationPrefix(tool: Tool): string {
  const hints = tool.annotations;
  if (hints?.destructiveHint === true && hints.readOnlyHint !== true) return '[may modify or delete data] ';
  if (hints?.readOnlyHint === true) return '[read-only] ';
  return '';
}
