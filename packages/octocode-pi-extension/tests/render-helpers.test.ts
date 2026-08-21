import assert from 'node:assert/strict';
import { visibleWidth as piVisibleWidth } from '@earendil-works/pi-tui';
import { test } from 'vitest';
import {
  buildOctocodeRenderCall,
  buildOctocodeRenderResult,
  buildResultStats,
  buildToolCallSummary,
  makeRenderer,
  sanitizeLine,
  singleLineRenderer,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from '../src/tools/render-helpers.js';
import { CLI_GLYPH, cliSpinnerFrame, formatCliToolRow, formatThinkingRow, summarizeInlineValue } from '../src/tui/cli-design.js';
import type { PiTheme, ToolCallResult } from '../src/types.js';

const theme: PiTheme = {
  bold: (text: string) => `<b>${text}</b>`,
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

function textResult(text: string, details: unknown = {}, isError = false): ToolCallResult {
  return {
    isError,
    content: [{ type: 'text', text }],
    details,
  };
}

test('CLI design contract centralizes glyphs, spinners, and transcript rows', () => {
  assert.equal(CLI_GLYPH.tool, '◇');
  assert.equal(cliSpinnerFrame(0), '⠋');
  assert.equal(cliSpinnerFrame(120), '⠙');
  assert.equal(summarizeInlineValue({ command: 'echo ok' }), '{"command":"echo ok"}');

  // Wide explicit width: the stub theme's <token> markers count as visible
  // cells, so the row must not be truncated for the exact-equality assertion.
  assert.equal(
    formatCliToolRow('running', 'bash', { command: 'echo ok' }, theme, 500),
    '<toolTitle>╭─ ⚙</toolTitle> <toolTitle>bash</toolTitle> <dim>running…</dim><dim> · {"command":"echo ok"}</dim>',
  );
  // Narrow terminals clip the row to width so the ╭─ frame never wraps.
  const clipped = formatCliToolRow('running', 'bash', { command: 'echo ok'.repeat(30) }, undefined, 40);
  assert.ok(visibleWidth(clipped) <= 40, `row must clip to width, got ${visibleWidth(clipped)} cells`);
  assert.equal(
    formatThinkingRow('start', theme),
    '<warning>╭─ 🧠 thinking</warning> <dim>model reasoning</dim>',
  );
});

test('ANSI-aware rendering helpers keep visible width stable', () => {
  assert.equal(visibleWidth('\x1b[31mred\x1b[0m plain'), 9);
  assert.equal(truncateToWidth('abcdef', 4), 'abc\x1b[0m…\x1b[0m');
  assert.equal(truncateToWidth('abcdef', 0), '');
  assert.equal(truncateToWidth('abcdef', 1), '\x1b[0m…\x1b[0m');
  assert.equal(truncateToWidth('\x1b[31mabcdef\x1b[0m', 5), '\x1b[31mabcd\x1b[0m…\x1b[0m');

  // Regression: tab in agent-ledger preview crashed pi TUI (width undercount)
  assert.equal(visibleWidth('a\tb'), 5); // tab expands to 3 spaces, pi-tui parity
  assert.equal(truncateToWidth('27:\tkeypress', 20), '27:   keypress');
  assert.ok(!truncateToWidth('x\ty\tz', 5).includes('\t'));
  assert.equal(visibleWidth('\u{1F600}'), 2); // emoji counts 2 cols
  assert.equal(visibleWidth('⧗'), 1); // ledger icon stays narrow, pi-tui parity
  const wide = truncateToWidth('\u{1F600}\u{1F600}\u{1F600}', 4);
  assert.ok(visibleWidth(wide) <= 4);
  assert.equal(visibleWidth('a\rb\x00c'), 5); // control chars become spaces

  // Regression: truncated output must never exceed maxWidth as measured by
  // pi-tui itself (the renderer crashes on `piVisibleWidth(line) > width`).
  // These char classes undercounted in the hand-rolled width model: EAW-wide
  // singletons (⌚ ⭐ ⬛), VS16 emoji (©️ ‼️), keycaps (1️⃣), flags, ZWJ families.
  const nasty = [
    '⌚⏳⭐⬛◽ watch',
    '©️™️‼️↩️ vs16',
    '1️⃣2️⃣#️⃣ keycaps',
    '🇺🇸🇯🇵 flags',
    '👨‍👩‍👧‍👦 family',
    '\x1b[31m⭐ tab\there\x1b[0m',
    'あいうえお漢字',
  ];
  for (const s of nasty) {
    for (const w of [3, 5, 8, 12]) {
      assert.ok(
        piVisibleWidth(truncateToWidth(s, w)) <= w,
        `pi-tui width of truncate(${JSON.stringify(s)}, ${w})`,
      );
    }
    assert.equal(visibleWidth(s), piVisibleWidth(sanitizeLine(s)));
  }

  assert.deepEqual(wrapText('alpha beta gamma', 10), ['alpha beta', 'gamma']);
  assert.deepEqual(wrapText('superlongword tiny', 5), ['super', 'tiny']);
  assert.deepEqual(wrapText('', 10), ['']);
  assert.deepEqual(wrapText('abc', 0), []);

  const renderer = makeRenderer(() => ['x'.repeat(20)]);
  assert.equal(visibleWidth(renderer.render(6)[0]!), 6);
  assert.equal(singleLineRenderer('single long line').render(8)[0], 'single \x1b[0m…\x1b[0m');
});

test('buildToolCallSummary formats each Octocode direct-tool family', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['ghSearchCode', { queries: [{ owner: 'octo', repo: 'repo', keywords: ['foo', 'bar'], language: 'ts', filename: 'a.ts' }, { keywords: ['more'] }] }, /"foo bar".*file:a\.ts.*lang:ts.*in octo\/repo.*\+1/],
    ['ghSearchRepos', { queries: [{ keywords: ['agent'], language: 'Rust' }] }, /"agent".*lang:Rust/],
    ['ghGetFileContent', { queries: [{ owner: 'octo', repo: 'repo', path: 'src/a.ts', matchString: 'needle in haystack' }] }, /octo\/repo:src\/a\.ts \/needle in haystack\//],
    ['ghGetFileContent', { queries: [{ owner: 'octo', repo: 'repo', path: 'src/a.ts', startLine: 3, endLine: 8 }] }, /:src\/a\.ts:3-8/],
    ['ghViewRepoStructure', { queries: [{ owner: 'octo', repo: 'repo', path: 'packages/pi' }] }, /octo\/repo\/packages\/pi/],
    ['ghHistoryResearch', { queries: [{ owner: 'octo', repo: 'repo', type: 'commits', prNumber: 17 }] }, /octo\/repo commits#17/],
    ['ghCloneRepo', { queries: [{ owner: 'octo', repo: 'repo', sparsePath: 'src' }] }, /octo\/repo\/src/],
    ['ghUnknown', { queries: [{ owner: 'octo', repo: 'repo' }] }, /octo\/repo/],
    ['localSearchCode', { queries: [{ searchText: 'class Foo', path: '/very/long/path/to/project/src', mode: 'ast' }, { searchText: 'next' }] }, /\[ast\] "class Foo".*project\/src.*\+1/],
    ['localGetFileContent', { queries: [{ path: '/tmp/src/file.ts', startLine: 10, endLine: 12 }] }, /file\.ts:10-12/],
    ['localGetFileContent', { queries: [{ path: '/tmp/src/file.ts', matchString: 'export function longName' }] }, /file\.ts \/export function long/],
    ['localViewStructure', { queries: [{ path: '/tmp/workspace', maxDepth: 4 }] }, /workspace depth:4/],
    ['localFindFiles', { queries: [{ path: '/tmp/workspace', names: ['a.ts', 'b.ts'], pathPattern: 'src/**' }] }, /workspace \[a\.ts, b\.ts\] src\/\*\*/],
    ['localBinaryInspect', { queries: [{ path: '/tmp/archive.zip', mode: 'list' }] }, /archive\.zip \(list\)/],
    ['lspGetSemantics', { queries: [{ type: 'references', symbolName: 'run', uri: 'file:///tmp/src/main.ts?x=1', lineHint: 42 }] }, /references "run" in main\.ts:42/],
    ['npmSearch', { queries: [{ packageName: 'vitest' }] }, /vitest/],
    ['customTool', { queries: [{ id: 'skip', reasoning: 'skip', alpha: 'one', beta: 'two', gamma: 'three', delta: 'four' }] }, /one two three/],
  ];

  for (const [toolName, args, pattern] of cases) {
    assert.match(buildToolCallSummary(toolName, args), pattern, toolName);
  }

  assert.equal(buildToolCallSummary('ghSearchCode', {}), '');
  assert.equal(buildToolCallSummary('localGetFileContent', { queries: [{ path: 'short.ts' }] }), 'short.ts');
});

test('buildResultStats extracts meaningful per-tool result summaries', () => {
  const result = (data: Record<string, unknown>) => ({ data });

  assert.deepEqual(buildResultStats('ghSearchCode', { results: [result({ totalCount: 7 }), result({ items: [{ path: 'src/a.ts' }, { repository: { fullName: 'octo/repo' } }] })] }), {
    queryCount: 2,
    summary: '9 results',
    paths: undefined,
    previews: ['src/a.ts', 'octo/repo'],
  });
  assert.deepEqual(buildResultStats('ghSearchRepos', { results: [result({ items: [{ fullName: 'a/repo' }, { name: 'fallback' }] })] }), {
    queryCount: 1,
    summary: '2 results',
    paths: ['a/repo', 'fallback'],
    previews: ['a/repo', 'fallback'],
  });
  assert.deepEqual(buildResultStats('ghGetFileContent', { results: [result({ path: 'src/a.ts', content: 'export const a = 1;' }), result({ filePath: 'src/b.ts' })] }), {
    queryCount: 2,
    paths: ['a.ts', 'b.ts'],
    previews: ['export const a = 1;'],
  });
  assert.deepEqual(buildResultStats('ghViewRepoStructure', { results: [result({ totalEntries: 5 }), result({ files: ['a', 'b'] })] }), {
    queryCount: 2,
    summary: '7 entries',
  });
  assert.deepEqual(buildResultStats('ghCloneRepo', { results: [result({ localPath: '/tmp/repo' }), result({ path: '/tmp/other' })] }), {
    queryCount: 2,
    paths: ['/tmp/repo', '/tmp/other'],
  });
  assert.deepEqual(buildResultStats('localSearchCode', { results: [result({ totalMatches: 3, totalFiles: 2 }), result({ matches: [{}, {}] })] }), {
    queryCount: 2,
    summary: '5 matches, 2 files',
  });
  assert.deepEqual(buildResultStats('localGetFileContent', { results: [result({ resolvedPath: '/tmp/a.ts', totalLines: 9, content: 'function run() {}' })] }), {
    queryCount: 1,
    paths: ['a.ts'],
    summary: '9 lines',
    previews: ['function run() {}'],
  });
  assert.deepEqual(buildResultStats('localViewStructure', { results: [result({ files: ['a'] })] }), {
    queryCount: 1,
    summary: '1 entries',
  });
  assert.deepEqual(buildResultStats('localFindFiles', { results: [result({ entries: ['a', 'b'] }), result({ totalEntries: 3 })] }), {
    queryCount: 2,
    summary: '5 files',
  });
  assert.deepEqual(buildResultStats('lspGetSemantics', { results: [result({ location: { uri: 'file:///tmp/a.ts', line: 12 }, references: [{}, {}] }), result({ symbols: [{}] })] }), {
    queryCount: 2,
    paths: ['a.ts:12'],
    summary: '3 refs',
  });
  assert.deepEqual(buildResultStats('npmSearch', { results: [result({ name: 'pkg', version: '1.2.3' }), result({ packageName: 'other' })] }), {
    queryCount: 2,
    paths: ['pkg@1.2.3', 'other'],
  });
  assert.deepEqual(buildResultStats('ghHistoryResearch', { results: [result({ items: [{}, {}] }), result({ prs: [{}] }), result({ commits: [{}, {}, {}] })] }), {
    queryCount: 3,
    summary: '6 items',
  });
  assert.deepEqual(buildResultStats('unknown', { results: [result({})] }), { queryCount: 1 });
  assert.deepEqual(buildResultStats('unknown', null), {});
});

test('Octocode renderers cover partial, collapsed, expanded, stats, and error states', () => {
  const call = buildOctocodeRenderCall('ghSearchCode', { queries: [{ owner: 'o', repo: 'r', keywords: ['x'] }] }, theme).render(120)[0]!;
  assert.match(call, /<accent>◇<\/accent>/);
  assert.match(call, /<toolTitle><b>ghSearchCode<\/b><\/toolTitle>/);
  assert.match(call, /<dim> · <\/dim><dim>"x" in o\/r<\/dim>/);

  const running = buildOctocodeRenderResult('localSearchCode', textResult('still running'), { isPartial: true }, theme).render(120)[0]!;
  assert.match(running, /<warning>⠋|<warning>⠙|<warning>⠹|<warning>⠸|<warning>⠼|<warning>⠴|<warning>⠦|<warning>⠧|<warning>⠇|<warning>⠏/);
  assert.match(running, /<toolTitle>localSearchCode<\/toolTitle>/);
  assert.match(running, /<dim>running…<\/dim>/);

  const collapsed = buildOctocodeRenderResult(
    'localSearchCode',
    textResult('ok', { results: [{ data: { totalMatches: 4, totalFiles: 2 } }] }),
    { expanded: false },
    theme,
  ).render(180)[0]!;
  assert.match(collapsed, /<success>✓<\/success>/);
  assert.match(collapsed, /4 matches, 2 files/);

  const withPreview = buildOctocodeRenderResult(
    'localGetFileContent',
    textResult('ok', { results: [{ data: { resolvedPath: '/tmp/a.ts', totalLines: 2, content: 'const answer = 42;' } }] }),
    { expanded: false },
    theme,
  ).render(180)[0]!;
  assert.match(withPreview, /a\.ts/);
  assert.match(withPreview, /“const answer = 42;”/);

  const expanded = buildOctocodeRenderResult(
    'ghGetFileContent',
    textResult(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'), { results: [{ data: { path: 'src/a.ts' } }] }),
    { expanded: true },
    theme,
  ).render(80);
  assert.equal(expanded.length, 27);
  assert.match(expanded.at(-1)!, /5 more lines hidden/);

  const error = buildOctocodeRenderResult('npmSearch', textResult('bad', {}, true), { expanded: false }, theme).render(120)[0]!;
  assert.match(error, /<error>✗<\/error>/);
});
