import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SUMMARY_SECTIONS } from '../src/compaction-prompt.js';
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
async function startSession(mcpServers: Record<string, unknown>, options: { tools?: string[]; settings?: Record<string, unknown>; agentSettings?: Record<string, unknown>; models?: Array<{ id: string; inputCost: number; maxTokens: number }> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-e2e-'));
  const cwd = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  if (options.agentSettings) fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify(options.agentSettings));
  const originalHome = process.env['HOME'];
  const originalAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['HOME'] = home; // keep the developer's own MCP config out of the test
  process.env['PI_CODING_AGENT_DIR'] = agentDir; // and their Pi settings
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }));
  const turns: Turn[] = [];
  const models = options.models ?? [{ id: 'faux-1', inputCost: 0, maxTokens: 4_096 }];
  const faux = createFauxCore({ provider: 'faux', models: models.map(({ id, maxTokens }) => ({ id, contextWindow: 200_000, maxTokens })) as never });
  const provider: ExtensionFactory = (pi) => {
    pi.registerProvider('faux', {
      name: 'Faux',
      api: faux.api,
      baseUrl: 'http://127.0.0.1:0',
      apiKey: 'test',
      models: faux.models.map((model, index) => ({ ...model, cost: { input: models[index]!.inputCost, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      streamSimple: faux.streamSimple,
    } as never);
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, ...options.settings });
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
  const { session } = await createAgentSession({ cwd, agentDir: path.join(root, 'agent'), resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd), ...(options.tools ? { tools: options.tools } : {}) });
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
    if (originalAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = originalAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { cwd, session, faux, run, dispose };
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

  it('keeps Pi read while Octocode is not the one providing a reader', async () => {
    // echo has localGetFileContent too, but only Octocode's reader replaces read, and only once active.
    const turn = (await s.run('hi', [say('ok')])).at(-1)!;
    expect(turn.tools).toContain('read');
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
    expect(call!.lastResults[0]!.text).toMatch(/Loaded 6 tool/);
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

describe('compaction', () => {
  let s: Awaited<ReturnType<typeof startSession>>;
  const OCTOCODE_MARKER = 'You write context checkpoints for a coding agent';
  const textOf = (context: TranscriptContext) =>
    [
      String((context as { systemPrompt?: string }).systemPrompt ?? ''),
      ...context.messages.map((message) => (Array.isArray(message.content) ? message.content.map((part) => ('text' in part ? part.text : '')).join('') : String(message.content ?? ''))),
    ].join('\n');
  const fullSummary = (label: string) =>
    `<analysis>private notes</analysis>\n<summary>\n${SUMMARY_SECTIONS.map((section) => `## ${section}\n${label} ${section.toLowerCase()}`).join('\n\n')}\n</summary>`;
  const compactionEntries = () => s.session.sessionManager.getEntries().filter((entry) => entry.type === 'compaction') as Array<{ fromHook?: boolean; summary: string; details?: Record<string, unknown> }>;
  interface SummaryCall {
    model: string;
    octocode: boolean;
    prefix: boolean;
    text: string;
  }
  /** Answers every summary request (history and split-turn prefix) through `reply`, recording each call. */
  const script = (reply: (call: SummaryCall, index: number) => ReturnType<typeof fauxAssistantMessage>) => {
    const log: SummaryCall[] = [];
    s.faux.setResponses(
      Array.from({ length: 10 }, () => (context: TranscriptContext, _options: unknown, _state: unknown, model: { id: string }) => {
        const text = textOf(context);
        const call = { model: model.id, octocode: text.includes(OCTOCODE_MARKER), prefix: text.includes('is the beginning of a turn whose later messages') || text.includes('Later messages are stored separately'), text };
        log.push(call);
        return reply(call, log.length - 1);
      }),
    );
    return log;
  };

  beforeAll(async () => {
    s = await startSession(
      { octocode: { disabled: true } },
      {
        // A priced session model plus a cheaper small-tier model of the same provider.
        models: [
          { id: 'faux-1', inputCost: 3, maxTokens: 32_000 },
          { id: 'faux-haiku', inputCost: 1, maxTokens: 16_000 },
        ],
        // Session: small keep window so a short history compacts. User settings (read from the agent dir): fast retries.
        settings: { compaction: { enabled: false, keepRecentTokens: 50 } },
        agentSettings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
      },
    );
  }, 60_000);
  afterAll(() => s.dispose());

  it('summarizes on the small model with the structured Octocode prompt, retrying transient errors per user settings', async () => {
    fs.writeFileSync(path.join(s.cwd, 'notes.txt'), 'hello\n');
    await s.run('Please read notes.txt and create todo.txt', [
      calls(fauxToolCall('read', { path: 'notes.txt' })),
      calls(fauxToolCall('file', { queries: [{ reasoning: 'create', type: 'write', path: 'todo.txt', content: 'x' }] })),
      say(`Done. ${'detail '.repeat(300)}`),
    ]);
    await s.run('Now keep going with the plan', [say(`More work. ${'detail '.repeat(300)}`)]);
    let failed = false;
    const log = script((call) => {
      if (call.octocode && !call.prefix && !failed) {
        failed = true;
        return fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 overloaded' });
      }
      return fauxAssistantMessage(call.prefix ? '<summary>## Turn Request\nprefix</summary>' : fullSummary('small'));
    });
    await s.session.compact('keep the notes');
    const history = log.filter((call) => call.octocode && !call.prefix);
    expect(history.map((call) => call.model)).toEqual(['faux-haiku', 'faux-haiku']); // one transient failure, one retry
    expect(history[1]!.text).toContain('Please read notes.txt and create todo.txt'); // user messages reach the prompt verbatim
    expect(history[1]!.text).toContain('focus on: keep the notes');
    const entry = compactionEntries().at(-1)!;
    expect(entry.fromHook).toBe(true);
    expect(entry.details).toMatchObject({ summaryModel: 'faux/faux-haiku', readFiles: ['notes.txt'], modifiedFiles: ['todo.txt'] });
    expect(entry.summary).toContain('## Next Step');
    expect(entry.summary).not.toContain('private notes'); // the analysis scratchpad is dropped
    expect(entry.summary).toMatch(/<read-files>\nnotes\.txt\n<\/read-files>[\s\S]*<modified-files>\ntodo\.txt\n<\/modified-files>/);
  }, 60_000);

  it('requires fresh reads after compaction', async () => {
    const turns = await s.run('overwrite', [calls(fauxToolCall('file', { queries: [{ reasoning: 'replace', type: 'write', path: 'notes.txt', content: 'x' }] })), say('done')]);
    expect(turns.at(-1)!.lastResults[0]!.text).toMatch(/has not been read/);
  }, 60_000);

  it('moves to the session model when the small model drifts from the format, merging the previous checkpoint', async () => {
    await s.run('more', [say(`Even more. ${'detail '.repeat(300)}`)]);
    const log = script((call) => fauxAssistantMessage(call.prefix ? '<summary>## Turn Request\nprefix</summary>' : call.model === 'faux-haiku' ? 'a short summary' : fullSummary('session')));
    await s.session.compact();
    const history = log.filter((call) => call.octocode && !call.prefix);
    expect(history.map((call) => call.model)).toEqual(['faux-haiku', 'faux-1']);
    expect(history[1]!.text).toContain('<previous-summary>');
    expect(history[1]!.text).toContain('Keep everything from the previous summary');
    const entry = compactionEntries().at(-1)!;
    expect(entry.details).toMatchObject({ summaryModel: 'faux/faux-1' });
    // Files from the earlier Octocode checkpoint are carried forward (Pi only carries its own).
    expect(entry.details!['modifiedFiles']).toEqual(expect.arrayContaining(['todo.txt']));
  }, 60_000);

  it('hands over to Pi default summarizer when Octocode summaries fail', async () => {
    await s.run('more', [say(`Even more. ${'detail '.repeat(300)}`)]);
    const log = script((call) =>
      call.octocode ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'invalid request: bad schema' }) : fauxAssistantMessage('## Goal\nDefault summary'),
    );
    await s.session.compact();
    expect(log.filter((call) => call.octocode).length).toBeGreaterThanOrEqual(2); // small model, then session model; not retried
    expect(compactionEntries().at(-1)!.fromHook).not.toBe(true);
    expect(compactionEntries().at(-1)!.summary).toContain('Default summary');
  }, 60_000);
});

describe('with a tool allowlist that leaves out file', () => {
  let s: Awaited<ReturnType<typeof startSession>>;
  beforeAll(async () => {
    s = await startSession({ octocode: { disabled: true } }, { tools: ['read', 'bash', 'edit', 'write'] });
  }, 60_000);
  afterAll(() => s.dispose());

  it('keeps Pi edit and write, so the agent can still change files', async () => {
    const turn = (await s.run('hi', [say('ok')])).at(-1)!;
    expect(turn.tools).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']));
    expect(turn.tools).not.toContain('file');
  });
});

