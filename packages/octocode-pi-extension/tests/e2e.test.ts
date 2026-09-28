import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import octocode from '../src/index.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo-mcp.mjs');

interface Turn {
  systemPrompt: string;
  tools: string[];
  lastResults: Array<{ toolName: string; isError: boolean; text: string }>;
}

function snapshot(context: TranscriptContext): Turn {
  const results: Turn['lastResults'] = [];
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index] as { role: string; toolName?: string; isError?: boolean; content?: unknown };
    if (message.role === 'system') continue; // tool/prompt deltas are recorded as system messages
    if (message.role !== 'toolResult') break;
    const text = Array.isArray(message.content) ? message.content.map((part: { text?: string }) => part.text ?? '').join('') : '';
    results.unshift({ toolName: String(message.toolName), isError: message.isError === true, text });
  }
  return { systemPrompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map((tool) => tool.name), lastResults: results };
}

type Reply = ReturnType<typeof fauxAssistantMessage>;

/** A real Pi agent session running the Octocode extension against a scripted model. */
async function startSession(mcpServers: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-e2e-'));
  const cwd = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const originalHome = process.env['HOME'];
  process.env['HOME'] = home; // keep the developer's own MCP config out of the test
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }));
  const turns: Turn[] = [];
  const faux = createFauxCore({ provider: 'faux', models: [{ id: 'faux-1', contextWindow: 200_000, maxTokens: 4_096 }] });
  const provider: ExtensionFactory = (pi) => {
    pi.registerProvider('faux', {
      name: 'Faux',
      api: faux.api,
      baseUrl: 'http://127.0.0.1:0',
      apiKey: 'test',
      models: faux.models.map((model) => ({ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      streamSimple: faux.streamSimple,
    } as never);
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: path.join(root, 'agent'),
    settingsManager,
    extensionFactories: [
      { name: 'faux-provider', factory: provider },
      { name: 'octocode', factory: octocode as ExtensionFactory },
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: path.join(root, 'agent'), resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
  await session.bindExtensions({ mode: 'json', shutdownHandler: () => undefined } as never);
  await session.setModel(session.modelRuntime.getModel('faux', 'faux-1')!);
  const run = async (prompt: string, replies: Array<(turn: Turn) => Reply>) => {
    faux.setResponses(
      replies.map((reply) => (context: TranscriptContext) => {
        const turn = snapshot(context);
        turns.push(turn);
        return reply(turn);
      }),
    );
    await session.prompt(prompt);
    return turns;
  };
  const dispose = async () => {
    await session.dispose?.();
    process.env['HOME'] = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { cwd, session, run, dispose };
}

const calls = (...toolCalls: ReturnType<typeof fauxToolCall>[]) => () => fauxAssistantMessage(toolCalls, { stopReason: 'toolUse' });
const say = (text: string) => () => fauxAssistantMessage(text);

describe('with Octocode MCP (default)', () => {
  let s: Awaited<ReturnType<typeof startSession>>;
  beforeAll(async () => {
    s = await startSession({});
    fs.writeFileSync(path.join(s.cwd, 'app.ts'), 'export const answer = 41;\n');
    fs.writeFileSync(path.join(s.cwd, 'unread.txt'), 'never read\n');
  }, 60_000);
  afterAll(() => s.dispose());

  it('replaces read/edit/write with Octocode tools and the file tool', async () => {
    const turn = (await s.run('hello', [say('ready')])).at(-1)!;
    expect(turn.tools).toContain('file');
    expect(turn.tools).toContain('octocode_localGetFileContent');
    expect(turn.tools).toContain('octocode_localSearch');
    for (const name of ['read', 'edit', 'write']) expect(turn.tools).not.toContain(name);
    expect(turn.systemPrompt).toContain('<octocode>');
    expect(turn.systemPrompt).toContain('localGetFileContent');
  }, 60_000);

  it('reads through Octocode, then edits, writes and deletes with batched file calls', async () => {
    const appPath = path.join(s.cwd, 'app.ts');
    const turns = await s.run('fix the answer', [
      calls(fauxToolCall('octocode_localGetFileContent', { queries: [{ goal: 'see value', reasoning: 'need current code', path: appPath, fullContent: true }] })),
      calls(
        fauxToolCall('file', {
          queries: [
            { reasoning: 'answer is off by one', type: 'edit', path: 'app.ts', edits: [{ oldText: '41', newText: '42' }] },
            { reasoning: 'document the constant', type: 'write', path: 'NOTES.md', content: '# Notes\n' },
            { reasoning: 'replace a file never read', type: 'write', path: 'unread.txt', content: 'clobbered' },
          ],
        }),
      ),
      calls(fauxToolCall('file', { queries: [{ reasoning: 'no longer needed', type: 'delete', path: 'NOTES.md' }] })),
      say('done'),
    ]);
    const [afterRead, afterBatch, afterDelete] = turns.slice(-3);
    expect(afterRead!.lastResults[0]!.text).toContain('export const answer = 41');
    const batch = afterBatch!.lastResults[0]!;
    expect(batch.isError).toBe(false);
    expect(batch.text).toMatch(/1\. OK edit app\.ts/);
    expect(batch.text).toMatch(/2\. OK write NOTES\.md/);
    expect(batch.text).toMatch(/3\. FAILED write unread\.txt: .*has not been read/);
    expect(afterDelete!.lastResults[0]!.text).toMatch(/OK delete NOTES\.md/);
    expect(fs.readFileSync(appPath, 'utf8')).toBe('export const answer = 42;\n');
    expect(fs.readFileSync(path.join(s.cwd, 'unread.txt'), 'utf8')).toBe('never read\n');
    expect(fs.existsSync(path.join(s.cwd, 'NOTES.md'))).toBe(false);
  }, 60_000);

  it('refuses to edit a file that changed on disk after it was read', async () => {
    const appPath = path.join(s.cwd, 'app.ts');
    const turns = await s.run('edit again', [
      () => {
        fs.writeFileSync(appPath, 'export const answer = 7;\n'); // someone else edits the file
        return fauxAssistantMessage([fauxToolCall('file', { queries: [{ reasoning: 'bump', type: 'edit', path: 'app.ts', edits: [{ oldText: '42', newText: '43' }] }] })], { stopReason: 'toolUse' });
      },
      say('done'),
    ]);
    const result = turns.at(-1)!.lastResults[0]!;
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/changed on disk since you last read it/);
  }, 60_000);
});

describe('with other MCP servers and Octocode disabled', () => {
  let s: Awaited<ReturnType<typeof startSession>>;
  beforeAll(async () => {
    s = await startSession({ octocode: { disabled: true }, echo: { command: process.execPath, args: [FIXTURE] } });
  }, 60_000);
  afterAll(() => s.dispose());

  it('keeps Pi read as the fallback and defers MCP tools', async () => {
    const turn = (await s.run('hello', [say('ready')])).at(-1)!;
    expect(turn.systemPrompt).toContain('Other MCP servers are connected (echo)');
    for (const name of ['read', 'file', 'bash', 'mcp', 'web', 'browser', 'agent', 'askUser']) expect(turn.tools).toContain(name);
    for (const name of ['edit', 'write', 'echo_shout']) expect(turn.tools).not.toContain(name);
  });

  it('guards writes: new files are fine, unread existing files are refused, read-then-write works', async () => {
    fs.writeFileSync(path.join(s.cwd, 'existing.txt'), 'original\n');
    const turns = await s.run('write files', [
      calls(fauxToolCall('file', { queries: [{ reasoning: 'new', type: 'write', path: 'new.txt', content: 'fresh' }, { reasoning: 'clobber', type: 'write', path: 'existing.txt', content: 'x' }] })),
      calls(fauxToolCall('read', { path: 'existing.txt' })),
      calls(fauxToolCall('file', { queries: [{ reasoning: 'replace', type: 'write', path: 'existing.txt', content: 'replaced' }] })),
      say('done'),
    ]);
    const [writes, , rewrite] = turns.slice(-3);
    expect(writes!.lastResults[0]!.text).toMatch(/1\. OK write new\.txt[\s\S]*2\. FAILED write existing\.txt: .*has not been read/);
    expect(rewrite!.lastResults[0]!.text).toMatch(/OK write existing\.txt/);
    expect(fs.readFileSync(path.join(s.cwd, 'existing.txt'), 'utf8')).toBe('replaced');
  });

  it('loads MCP tools on demand and calls them, surfacing remote errors', async () => {
    const turns = await s.run('use echo', [calls(fauxToolCall('mcp', { server: 'echo' })), calls(fauxToolCall('echo_shout', { text: 'hi' }), fauxToolCall('echo_fail', {})), say('done')]);
    const [load, call, final] = turns.slice(-3);
    expect(load!.tools).not.toContain('echo_shout');
    expect(call!.lastResults[0]!.text).toMatch(/Loaded 5 tool/);
    expect(final!.lastResults).toEqual([
      { toolName: 'echo_shout', isError: false, text: 'HI' },
      { toolName: 'echo_fail', isError: true, text: 'boom' },
    ]);
  });

  it('acts as an MCP host: exposes the workspace root and picks up tools added at runtime', async () => {
    const turns = await s.run('host', [calls(fauxToolCall('echo_roots', {}), fauxToolCall('echo_grow', {})), say('grown')]);
    expect((JSON.parse(turns.at(-1)!.lastResults[0]!.text) as Array<{ uri: string }>)[0]!.uri).toBe(pathToFileURL(s.cwd).href);
    await new Promise((resolve) => setTimeout(resolve, 800)); // list_changed refresh is debounced
    const late = await s.run('late', [calls(fauxToolCall('mcp', { query: 'late' })), calls(fauxToolCall('echo_late', {})), say('done')]);
    expect(late.at(-1)!.lastResults[0]).toEqual({ toolName: 'echo_late', isError: false, text: 'late tool works' });
  });

  it('trims old large tool results with persistent context edits at the turn boundary', async () => {
    fs.writeFileSync(path.join(s.cwd, 'big.txt'), 'line of text\n'.repeat(1_000));
    const reads = Array.from({ length: 22 }, () => fauxToolCall('read', { path: 'big.txt' }));
    const results = (await s.run('read a lot', [calls(...reads), say('done')])).at(-1)!.lastResults;
    expect(results).toHaveLength(22);
    expect(results.slice(0, 10).every((result) => /were trimmed/.test(result.text))).toBe(true);
    expect(results.slice(10).every((result) => result.text.length > 10_000)).toBe(true);
    expect(s.session.sessionManager.getEntries().filter((entry) => entry.type === 'context_edit')).toHaveLength(10);
  });

  it('answers askUser without a UI by telling the model to proceed', async () => {
    const question = { question: 'Which?', header: 'Pick', options: [{ label: 'A (Recommended)', description: 'a' }, { label: 'B', description: 'b' }] };
    const turns = await s.run('ask', [calls(fauxToolCall('askUser', { questions: [question] })), say('done')]);
    expect(turns.at(-1)!.lastResults[0]!.text).toMatch(/No interactive user/);
  });
});

describe('when the Octocode server goes away', () => {
  let s: Awaited<ReturnType<typeof startSession>>;
  beforeAll(async () => {
    // Stand-in for Octocode: same name, so it replaces read while it is connected.
    s = await startSession({ octocode: { command: process.execPath, args: [FIXTURE], env: {} } });
  }, 60_000);
  afterAll(() => s.dispose());

  it('restores Pi read and drops the dead server tools', async () => {
    const before = await s.run('stop it', [calls(fauxToolCall('octocode_exit', {})), say('stopped')]);
    expect(before[0]!.tools).not.toContain('read');
    expect(before[0]!.tools).toContain('octocode_shout');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = (await s.run('read now', [say('ok')])).at(-1)!;
    expect(after.tools).toContain('read');
    expect(after.tools).not.toContain('octocode_shout');
    expect(after.systemPrompt).toContain('Read files with `read`');
  }, 60_000);
});
