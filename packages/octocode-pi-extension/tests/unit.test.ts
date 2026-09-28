import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';
import { formatAnswers } from '../src/ask.js';
import { KEEP_RECENT_RESULTS, planToolResultTrims, TRIM_STEP } from '../src/compaction.js';
import { FileGuard, formatOutcomes, readPaths, resolvePath } from '../src/file-tool.js';
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
      '--mode', 'json', '--no-session', '--no-extensions', '-e', '/ext/index.js', '--exclude-tools', 'file', '--append-system-prompt', 'Review.', 'Review X',
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
