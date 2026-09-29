import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';
import { formatAnswers } from '../src/ask.js';
import { compactionPrompt, SUMMARY_SECTIONS, summaryLooksComplete } from '../src/compaction-prompt.js';
import { collectFileLists, pickCompactionModel, stripAnalysis } from '../src/compaction-summary.js';
import { initTheme, SettingsManager } from '@earendil-works/pi-coding-agent';
import { compactionRequestSettings, KEEP_RECENT_RESULTS, planToolResultTrims, TRIM_STEP } from '../src/compaction.js';
import { diffStats, FileGuard, formatOutcomes, querySize, readPaths, registerFileTool, resolvePath } from '../src/file-tool.js';
import { preview, queriesSummary } from '../src/render.js';
import { builtInServers, expandEnv, loadMcpServers, mcpToolName, parseMcpServers } from '../src/mcp-config.js';
import { clip, rank, toContent, type McpToolEntry } from '../src/mcp.js';
import { octocodePrompt } from '../src/prompt.js';
import { extraSkillDirs } from '../src/skills.js';
import { addUsage, assistantText, buildAgentArgs, emptyUsage, loadProfiles, parseProfile } from '../src/subagents.js';
import { bannerLines, tokensPerSecond } from '../src/ui.js';
import { htmlToText, isBinaryType, parseDuckDuckGo } from '../src/web.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-pi-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('file tool', () => {
  it('refuses to overwrite an unread file, allows new files, and requires existing files for edit/delete', () => {
    const dir = tmp();
    const file = path.join(dir, 'a.txt');
    const guard = new FileGuard();
    expect(guard.check(file, 'write', 'a.txt')).toBeUndefined();
    expect(guard.check(file, 'edit', 'a.txt')).toMatch(/does not exist/);
    fs.writeFileSync(file, 'one');
    expect(guard.check(file, 'write', 'a.txt')).toMatch(/has not been read/);
    expect(guard.check(file, 'edit', 'a.txt')).toBeUndefined();
  });

  it('detects files changed on disk after the last read and resets after compaction', () => {
    const dir = tmp();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'one');
    const guard = new FileGuard();
    guard.record(file);
    expect(guard.check(file, 'edit', 'a.txt')).toBeUndefined();
    fs.writeFileSync(file, 'changed by someone else');
    expect(guard.check(file, 'edit', 'a.txt')).toMatch(/changed on disk/);
    guard.reset();
    expect(guard.check(file, 'write', 'a.txt')).toMatch(/has not been read/);
  });

  it('learns reads from Octocode local file tools and Pi read', () => {
    expect(readPaths('octocode_localGetFileContent', { queries: [{ path: '/r/a.ts' }, { path: 'b.ts' }] }, '/r')).toEqual(['/r/a.ts', '/r/b.ts']);
    expect(readPaths('read', { path: '@src/x.ts' }, '/r')).toEqual(['/r/src/x.ts']);
    expect(readPaths('octocode_localSearch', { queries: [{ path: '/r' }] }, '/r')).toEqual([]);
    expect(resolvePath('/repo', '@src/x.ts')).toBe('/repo/src/x.ts');
  });

  it('reports each query independently', () => {
    expect(
      formatOutcomes([
        { type: 'write', path: 'a', reasoning: 'r', ok: true, message: 'Wrote a' },
        { type: 'edit', path: 'b', reasoning: 'r', ok: false, message: 'no match' },
      ]),
    ).toBe('1. OK write a: Wrote a\n2. FAILED edit b: no match');
  });
});

describe('MCP config', () => {
  it('merges files in order, lets later files override and disable servers', () => {
    const home = tmp();
    const cwd = tmp();
    fs.mkdirSync(path.join(home, '.octocode'));
    fs.writeFileSync(path.join(home, '.octocode', 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'a1' }, b: { url: 'https://b' } } }));
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { a: { args: ['x'] }, octocode: { disabled: true } } }));
    fs.writeFileSync(path.join(home, '.octocode', 'extra.json'), '{}');
    const servers = loadMcpServers(cwd, { home, builtIn: { octocode: { command: 'octocode-mcp' } } });
    expect(servers).toEqual({ a: { command: 'a1', args: ['x'] }, b: { url: 'https://b' } });
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { legacy: { command: 'l', directTools: true } } }));
    expect(loadMcpServers(cwd, { home, builtIn: {} })['legacy']).toMatchObject({ eager: true });
  });

  it('ships Octocode as an eager server scoped to the workspace, passing only GitHub tokens through', () => {
    const { octocode } = builtInServers('/work/repo', { GITHUB_TOKEN: 't', AWS_SECRET: 'x' });
    expect(octocode).toMatchObject({ eager: true, env: { WORKSPACE_ROOT: '/work/repo', ALLOWED_PATHS: '/work/repo', GITHUB_TOKEN: 't' } });
    expect(octocode!.env).not.toHaveProperty('AWS_SECRET');
    expect(octocode!.args?.[0]).toMatch(/octocode-mcp[\\/]dist[\\/]index\.js$/);
  });

  it('loads project MCP configs only for trusted projects', () => {
    const home = tmp();
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: 'rm' } } }));
    expect(loadMcpServers(cwd, { home, builtIn: {}, projectTrusted: false })).toEqual({});
    expect(loadMcpServers(cwd, { home, builtIn: {}, projectTrusted: true })).toEqual({ evil: { command: 'rm' } });
  });

  it('reports invalid JSON without failing the rest', () => {
    const home = tmp();
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, '.mcp.json'), '{nope');
    const errors: string[] = [];
    const servers = loadMcpServers(cwd, { home, builtIn: { octocode: { command: 'x' } }, onError: (file) => errors.push(file) });
    expect(Object.keys(servers)).toEqual(['octocode']);
    expect(errors).toEqual([path.join(cwd, '.mcp.json')]);
  });

  it('accepts the "servers" key, expands env references and builds safe tool names', () => {
    expect(parseMcpServers('{"servers":{"x":{"command":"c"}}}')).toEqual({ x: { command: 'c' } });
    expect(expandEnv('Bearer ${TOKEN}', { TOKEN: 't' })).toBe('Bearer t');
    expect(mcpToolName('my server', 'get.file')).toBe('my_server_get_file');
  });

  it('ranks tools by name matches before description matches', () => {
    const tools: McpToolEntry[] = [
      { server: 'octocode', remoteName: 'packageSearch', name: 'octocode_packageSearch', description: 'Search npm packages' },
      { server: 'octocode', remoteName: 'githubSearchCode', name: 'octocode_githubSearchCode', description: 'Search code on GitHub' },
    ];
    expect(rank(tools, 'github code').map((tool) => tool.remoteName)).toEqual(['githubSearchCode']);
    expect(rank(tools, 'search')).toHaveLength(2);
  });

  it('maps MCP content to Pi content', () => {
    expect(toContent({ content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AA', mimeType: 'image/png' }] })).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', data: 'AA', mimeType: 'image/png' },
    ]);
    expect(toContent({ content: [], structuredContent: { ok: true } })).toEqual([{ type: 'text', text: '{\n  "ok": true\n}' }]);
  });
});

describe('compaction', () => {
  const entry = (index: number, size: number) => ({
    id: `e${index}`,
    message: { role: 'toolResult', toolCallId: `c${index}`, content: [{ type: 'text', text: 'x'.repeat(size) }] },
  });

  it('waits for a full batch of old large results, then trims them with context edits', () => {
    const few = Array.from({ length: KEEP_RECENT_RESULTS + TRIM_STEP - 1 }, (_, index) => entry(index, 10_000));
    expect(planToolResultTrims(few)).toEqual([]);

    const many = Array.from({ length: KEEP_RECENT_RESULTS + TRIM_STEP }, (_, index) => entry(index, 10_000));
    const edits = planToolResultTrims(many);
    expect(edits.map((edit) => edit.targetId)).toEqual(Array.from({ length: TRIM_STEP }, (_, index) => `e${index}`));
    const text = (edits[0]!.replacement as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text.length).toBeLessThan(2_000);
    expect(text).toMatch(/were trimmed/);
  });

  it('applies the user retry policy and transport timeouts to the summary request', () => {
    const custom = compactionRequestSettings(SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 5, baseDelayMs: 10, provider: { timeoutMs: 1_234, maxRetries: 1 } } }));
    expect(custom.retry).toMatchObject({ enabled: true, maxRetries: 5, baseDelayMs: 10 });
    expect(custom.request).toMatchObject({ timeoutMs: 1_234, maxRetries: 1 });
    const unlimited = compactionRequestSettings(SettingsManager.inMemory({ httpIdleTimeoutMs: 0 }));
    expect(unlimited.request.timeoutMs).toBe(2_147_483_647);
    expect(unlimited.retry.enabled).toBe(true);
  });

  it('picks the strongest cheaper small-tier model of the same provider that fits', () => {
    const model = (provider: string, id: string, input: number, contextWindow = 400_000, maxTokens = 32_000) =>
      ({ provider, id, cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens }) as never;
    const opus = model('anthropic', 'claude-opus-5-5', 5);
    const catalog = [
      opus,
      model('anthropic', 'claude-3-haiku', 0.25),
      model('anthropic', 'claude-haiku-4-5', 1),
      model('anthropic', 'claude-haiku-9', 0.5, 50_000), // too small a window
      model('openai', 'gpt-6-luna', 0.1),
      model('minimax', 'MiniMax-M3', 0.3),
    ];
    const pick = (current: never, needed = 100_000, override?: string) => pickCompactionModel(current, catalog, needed, override ?? '');
    expect(pick(opus)).toMatchObject({ reason: 'small', model: { id: 'claude-haiku-4-5' } });
    const gpt = model('openai', 'gpt-6', 2);
    expect(pickCompactionModel(gpt, [...catalog, gpt], 100_000, '')).toMatchObject({ model: { id: 'gpt-6-luna' } });
    expect(pick(model('minimax', 'MiniMax-M4', 1))).toMatchObject({ reason: 'current' }); // "MiniMax" is not a mini model
    expect(pick(opus, 500_000)).toMatchObject({ reason: 'current' }); // input larger than every small window
    expect(pick(model('local', 'llama', 0))).toMatchObject({ reason: 'current' }); // unknown price: keep the session model
    expect(pick(opus, 100_000, 'current')).toMatchObject({ reason: 'current', model: { id: 'claude-opus-5-5' } });
    expect(pick(opus, 100_000, 'openai/gpt-6-luna')).toMatchObject({ reason: 'override', model: { id: 'gpt-6-luna' } });
  });

  it('builds a structured prompt that keeps intent, flow and follow-ups', () => {
    const prompt = compactionPrompt({ update: false, userFocus: 'the auth bug' });
    for (const section of SUMMARY_SECTIONS) expect(prompt).toContain(`## ${section}`);
    expect(prompt).toMatch(/verbatim/);
    expect(prompt).toContain('focus on: the auth bug');
    expect(prompt).not.toContain('previous-summary');
    expect(compactionPrompt({ update: true })).toContain('<previous-summary>');
    const complete = SUMMARY_SECTIONS.map((section) => `## ${section}\nx`).join('\n');
    expect(summaryLooksComplete(complete)).toBe(true);
    expect(summaryLooksComplete('## User Intent\nonly this')).toBe(false);
    expect(stripAnalysis(`<analysis>scratch</analysis>\n<summary>\n${complete}\n</summary>`)).toBe(complete);
    expect(stripAnalysis('plain text')).toBe('plain text');
  });

  it('tracks files from Octocode tools and earlier Octocode checkpoints', () => {
    const preparation = {
      fileOps: { read: new Set(['a.ts']), written: new Set<string>(), edited: new Set(['b.ts']) },
      messagesToSummarize: [
        { role: 'assistant', content: [{ type: 'toolCall', name: 'file', arguments: { queries: [{ path: 'c.ts' }, { path: 'a.ts' }] } }] },
        { role: 'assistant', content: [{ type: 'toolCall', name: 'octocode_localGetFileContent', arguments: { queries: [{ path: 'd.ts' }] } }] },
      ],
      turnPrefixMessages: [],
    } as never;
    const previous = { type: 'compaction', fromHook: true, details: { readFiles: ['old-read.ts'], modifiedFiles: ['old-edit.ts'] } };
    expect(collectFileLists(preparation, [previous])).toEqual({ readFiles: ['d.ts', 'old-read.ts'], modifiedFiles: ['a.ts', 'b.ts', 'c.ts', 'old-edit.ts'] });
  });

  it('never trims subagent reports', () => {
    const results = Array.from({ length: KEEP_RECENT_RESULTS + TRIM_STEP }, (_, index) => entry(index, 10_000));
    results[0]!.message = { ...results[0]!.message, toolName: 'agent' } as typeof results[0]['message'];
    const edits = planToolResultTrims(results);
    expect(edits.map((edit) => edit.targetId)).not.toContain('e0');
  });

  it('ignores small results, images count as large, and user messages are never touched', () => {
    const small = [{ id: 'u', message: { role: 'user', content: 'hi' } }, ...Array.from({ length: 40 }, (_, index) => entry(index, 100))];
    expect(planToolResultTrims(small)).toEqual([]);
    const images = Array.from({ length: KEEP_RECENT_RESULTS + TRIM_STEP }, (_, index) => ({
      id: `i${index}`,
      message: { role: 'toolResult', content: [{ type: 'image', data: 'AA', mimeType: 'image/png' }] },
    }));
    expect((planToolResultTrims(images)[0]!.replacement as { content: unknown }).content).toEqual([{ type: 'text', text: '[image from an earlier tool call omitted]' }]);
  });
});

describe('subagents', () => {
  it('parses profile frontmatter and builds child pi arguments', () => {
    const profile = parseProfile('fallback', '---\nname: researcher\ndescription: Reads code\ntools: read,grep\n---\nBe precise.');
    expect(profile).toEqual({ name: 'researcher', description: 'Reads code', prompt: 'Be precise.', tools: 'read,grep' });
    expect(buildAgentArgs('Find X', profile, 'anthropic/claude', '/ext/index.js')).toEqual([
      '--mode', 'json', '--no-session', '--no-extensions', '-e', '/ext/index.js', '--model', 'anthropic/claude', '--tools', 'read,grep', '--append-system-prompt', 'Be precise.', 'Find X',
    ]);
  });

  it('clips long MCP descriptions at a sentence boundary', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('First sentence here. Second sentence is long.', 30)).toBe('First sentence here.…');
    expect(clip('x'.repeat(40), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('maps excludeTools frontmatter to --exclude-tools', () => {
    const profile = parseProfile('reviewer', '---\nexcludeTools: file\n---\nReview.');
    expect(profile.excludeTools).toBe('file');
    expect(buildAgentArgs('Review X', profile, undefined, '/ext/index.js')).toEqual([
      '--mode', 'json', '--no-session', '--no-extensions', '-e', '/ext/index.js', '--exclude-tools', 'file,edit,write', '--append-system-prompt', 'Review.', 'Review X',
    ]);
  });

  it('loads project profiles only for trusted projects', () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, '.pi', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.pi', 'agents', 'local.md'), '---\ndescription: Project profile\n---\nDo it.');
    expect(loadProfiles(cwd, tmp(), false).has('local')).toBe(false);
    expect(loadProfiles(cwd, tmp(), true).has('local')).toBe(true);
  });

  it('sums child model usage', () => {
    const total = emptyUsage();
    addUsage(total, { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 18, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } });
    addUsage(total, { output: 5, cost: { total: 0.1 } });
    addUsage(total, undefined);
    expect(total).toMatchObject({ input: 10, output: 10, totalTokens: 18 });
    expect(total.cost.total).toBeCloseTo(0.4);
  });

  it('extracts the final assistant text from a JSON event', () => {
    expect(assistantText({ role: 'assistant', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'Answer' }] })).toBe('Answer');
    expect(assistantText({ role: 'user', content: [] })).toBeUndefined();
  });
});

describe('prompt', () => {
  it('routes research through available servers and adapts to subagents', () => {
    const root = octocodePrompt({ mcpServers: ['octocode', 'linear'], profiles: [{ name: 'researcher', description: 'Reads code' }], canDelegate: true });
    expect(root).toContain('`octocode_localGetFileContent`');
    expect(root).toContain('overrides the generic rule to use bash');
    for (const tool of ['ghSearch', 'ghGetFileContent', 'ghSearchHistory', 'ghGetHistoryItem', 'ghCloneRepo', 'npmSearch']) expect(root).toContain(`\`octocode_${tool}\``);
    expect(root).toContain('Use `web` only for other sites');
    expect(root).toContain('(linear)');
    expect(root).toContain('- researcher: Reads code');
    expect(root).toContain('Use askUser');
    const child = octocodePrompt({ mcpServers: [], profiles: [], canDelegate: false });
    expect(child).toContain('You are a subagent');
    expect(child).toContain('Read files with `read`');
    expect(child).toContain('Use `web` (or the `gh` CLI in bash when available) for GitHub and npm lookups');
    expect(child).not.toContain('octocode_ghSearch');
    expect(child).toContain('You cannot ask the user');
    expect(child).not.toContain('askUser');
    expect(child).not.toContain('overrides the generic rule');
  });
});

describe('web', () => {
  it('converts HTML to readable text', () => {
    const text = htmlToText('<html><script>x()</script><h1>Title</h1><p>Hello &amp; <a href="/a">link</a></p><ul><li>one</li></ul></html>');
    expect(text).toBe('# Title\n\nHello & [link](/a)\n\n- one');
  });

  it('recognises binary content types', () => {
    expect(isBinaryType('application/pdf')).toBe(true);
    expect(isBinaryType('image/png')).toBe(true);
    expect(isBinaryType('application/octet-stream')).toBe(true);
    expect(isBinaryType('text/html; charset=utf-8')).toBe(false);
    expect(isBinaryType('application/json')).toBe(false);
    expect(isBinaryType('application/vnd.api+json')).toBe(false);
    expect(isBinaryType('')).toBe(false);
  });

  it('parses DuckDuckGo HTML results', () => {
    const html = '<div class="result__body"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a><a class="result__snippet">Snippet</a></div>';
    expect(parseDuckDuckGo(html, 5)).toEqual([{ title: 'Example', url: 'https://example.com', snippet: 'Snippet' }]);
  });
});

describe('misc', () => {
  it('discovers only existing skill directories', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    expect(extraSkillDirs(tmp(), home)).toEqual([path.join(home, '.claude', 'skills')]);
  });

  it('adds project skill directories only for trusted projects', () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, '.claude', 'skills'), { recursive: true });
    expect(extraSkillDirs(cwd, tmp(), false)).toEqual([]);
    expect(extraSkillDirs(cwd, tmp(), true)).toEqual([path.join(cwd, '.claude', 'skills')]);
  });

  it('renders a banner of constant height at any width', () => {
    const fg = (_: string, text: string) => text;
    expect(bannerLines(fg, 200, '1.0.0')).toHaveLength(8);
    expect(bannerLines(fg, 20)).toHaveLength(8);
    expect(bannerLines(fg, 4, '1.0.0').every((line) => visibleWidth(line) <= 4)).toBe(true);
  });

  it('computes output tokens per second of streaming time', () => {
    expect(tokensPerSecond(400, 4_000)).toBe(100);
    expect(tokensPerSecond(0, 1_000)).toBeUndefined();
    expect(tokensPerSecond(400, 0)).toBeUndefined();
  });

  it('formats askUser answers and declines', () => {
    expect(formatAnswers({ cancelled: false, answers: [{ question: 'Which?', answer: 'A', custom: false }] })).toBe('"Which?" → A');
    expect(formatAnswers({ cancelled: true, answers: [] })).toMatch(/declined/);
    const partial = formatAnswers({ cancelled: true, answers: [{ question: 'Which?', answer: 'A', custom: false }] });
    expect(partial).toMatch(/^"Which\?" → A\n/);
    expect(partial).toMatch(/declined to answer the remaining questions/);
  });
});

describe('tool rendering', () => {
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text } as never;
  const hint = () => 'ctrl+o to expand';

  it('shows each file change with its reasoning, size, outcome and a capped diff', () => {
    initTheme('dark');
    let tool: { renderCall: Function; renderResult: Function } | undefined;
    registerFileTool({ registerTool: (definition: never) => (tool = definition), on: () => undefined } as never, new FileGuard());
    const args = {
      queries: [
        { reasoning: 'Fix the off-by-one in the loop', type: 'edit', path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] },
        { reasoning: 'Add the missing test', type: 'write', path: 'test/a.test.ts', content: 'one\ntwo' },
      ],
    };
    const call = tool!.renderCall(args, theme, { lastComponent: undefined }).render(120).join('\n');
    expect(call).toMatch(/edit src\/a\.ts · 2 edits/);
    expect(call).toContain('↳ Fix the off-by-one in the loop');
    expect(call).toMatch(/write test\/a\.test\.ts · 2 lines/);
    expect(call).toContain('↳ Add the missing test');
    const diff = Array.from({ length: 30 }, (_, index) => `+${index} added line ${index}`).join('\n');
    const result = { content: [], details: { outcomes: [{ type: 'edit', path: 'src/a.ts', reasoning: '', ok: true, message: 'ok', diff }, { type: 'write', path: 'test/a.test.ts', reasoning: '', ok: false, message: 'has not been read' }] } };
    const collapsed = tool!.renderResult(result, { expanded: false, isPartial: false }, theme, { lastComponent: undefined, isError: false }).render(120).join('\n');
    expect(collapsed).toMatch(/✓ edit src\/a\.ts \+30 -0/);
    expect(collapsed).toMatch(/18 more diff lines/);
    expect(collapsed).toMatch(/✗ write test\/a\.test\.ts has not been read/);
    const expanded = tool!.renderResult(result, { expanded: true, isPartial: false }, theme, { lastComponent: undefined, isError: false }).render(120).join('\n');
    expect(expanded).toContain('added line 29');
    expect(expanded).not.toMatch(/more diff lines/);
  });

  it('counts diff lines and sizes queries', () => {
    expect(diffStats('+1 a\n-2 b\n-3 c\n 4 d')).toEqual({ added: 1, removed: 2 });
    expect(querySize({ type: 'edit', edits: [{}] })).toBe(' · 1 edit');
    expect(querySize({ type: 'delete' })).toBe('');
  });

  it('collapses long output with an expand hint and shows everything when expanded', () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    expect(preview(text, theme, false, { hint })).toBe(`${Array.from({ length: 6 }, (_, index) => `line ${index}`).join('\n')}\n… 14 more lines (ctrl+o to expand)`);
    expect(preview(text, theme, true, { hint }).split('\n')).toHaveLength(20);
    expect(preview('x'.repeat(1_000), theme, false, { hint }).length).toBeLessThan(300);
  });

  it('summarizes batched research queries with their targets and goals', () => {
    const lines = queriesSummary({ queries: [{ path: 'src/index.ts' }, { owner: 'o', repo: 'r', keywords: ['auth', 'token'], reasoning: 'Find the token check' }] }, theme);
    expect(lines).toEqual(['  src/index.ts', '  o/r auth token', '    ↳ Find the token check']);
  });
});

