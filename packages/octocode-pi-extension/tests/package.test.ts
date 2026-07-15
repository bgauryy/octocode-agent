// Contract tests for the pi-extension.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeAll, test, vi } from 'vitest';
import {
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  SYSTEM_PROMPT_MARKER,
  OCTOCODE_DIRECT_TOOL_NAMES,
  OCTOCODE_SUPPORT_TOOL_NAMES,
  disableBuiltinReadTool,
  formatStatus,
  applyOctocodeUi,
  formatOctocodeDashboard,
  formatOctocodeMetrics,
  getThinkingStatus,
  getAssetPaths,
  getInternalErrorLogPath,
  getCLIPath,
  getAppendSystemTarget,
  getInstallSource,
  listBundledSkills,
  listExtensionHarness,
  mergeManagedAppendSystem,
  parseSetupScope,
  readTextIfExists,
  shouldAppendSystemPrompt,
  splitArgs,
  truncateUserVisibleToolOutput,
  cleanupSpawnedAgentsForShutdown,
  evaluateSpawnPolicy,
  listWorkerLedgerEntries,
  runHookMiddleware,
  setAgentProcessFactoryForTests,
  normalizeWorkerOutput,
  evaluateWorkerRecoveryRisk,
} from '../src/index.js';
import {
  applyCustomEditsToContent,
  clearEditReadStateForTests,
  recordFileReadState,
} from '../src/tools/edit-tool.js';
import { assertPathAllowed } from '../src/tools/path-guard.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
const distDir = path.join(packageRoot, 'dist');
const EXPECTED_OCTOCODE_SKILLS = [
  'octocode-brainstorming',
  'octocode-prompt-optimizer',
  'octocode-research',
  'octocode-rfc-generator',
  'octocode-roast',
  'octocode-skills',
  'octocode-subagent',
];

let distAssetsReady = false;

function ensureDistAssetsForUnitTests(): void {
  if (distAssetsReady) return;
  if (fs.existsSync(path.join(distDir, 'index.js'))) {
    distAssetsReady = true;
    return;
  }
  execFileSync(
    process.execPath,
    [path.join(packageRoot, 'scripts', 'build.mjs')],
    {
      cwd: packageRoot,
      stdio: 'pipe',
    }
  );
  distAssetsReady = true;
}

beforeAll(() => {
  ensureDistAssetsForUnitTests();
}, 120_000);

// ─── Test helpers ─────────────────────────────────────────────────────────────

function withTempMemoryHome(fn: (tmp?: string) => void | Promise<void>) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-pi-test-'));
    const previousMemory = process.env['OCTOCODE_MEMORY_HOME'];
    const previousHome = process.env['OCTOCODE_HOME'];
    process.env['OCTOCODE_MEMORY_HOME'] = tmp;
    process.env['OCTOCODE_HOME'] = tmp;
    try {
      await fn(tmp);
    } finally {
      if (previousMemory === undefined) delete process.env['OCTOCODE_MEMORY_HOME'];
      else process.env['OCTOCODE_MEMORY_HOME'] = previousMemory;
      if (previousHome === undefined) delete process.env['OCTOCODE_HOME'];
      else process.env['OCTOCODE_HOME'] = previousHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

async function withAgentId(
  agentId: string,
  fn: () => Promise<void>
): Promise<void> {
  const previous = process.env['OCTOCODE_AGENT_ID'];
  process.env['OCTOCODE_AGENT_ID'] = agentId;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env['OCTOCODE_AGENT_ID'];
    else process.env['OCTOCODE_AGENT_ID'] = previous;
  }
}

interface ToolDef {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute: (
    id: string,
    params: Record<string, unknown>,
    sig?: unknown,
    upd?: unknown,
    ctx?: unknown
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
  renderCall?: (
    args: unknown,
    theme?: unknown
  ) => { render: (w?: number) => string[] };
  renderResult?: (
    result: unknown,
    opts: unknown,
    theme?: unknown
  ) => { render: (w?: number) => string[] };
  prepareArguments?: (args: unknown) => unknown;
}

interface CommandDef {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
}

interface CaptureResult {
  tools: Map<string, ToolDef>;
  commands: Map<string, CommandDef>;
  flags: Map<string, { description: string; type: string; default?: unknown }>;
  flagValues: Map<string, unknown>;
  sentUserMessages: Array<{ msg: string; opts?: Record<string, unknown> }>;
  handlers: Map<
    string,
    Array<(event: unknown, ctx: unknown) => void | Promise<void>>
  >;
  pi: {
    getActiveTools(): string[];
    setActiveTools(names: string[]): void;
  };
  activeTools: string[];
}
async function captureExtensions(): Promise<CaptureResult> {
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, CommandDef>();
  const flags = new Map<
    string,
    { description: string; type: string; default?: unknown }
  >();
  const flagValues = new Map<string, unknown>();
  const sentUserMessages: Array<{
    msg: string;
    opts?: Record<string, unknown>;
  }> = [];
  const activeTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: unknown) => void | Promise<void>>
  >();
  const pi = {
    registerTool: (def: ToolDef) => {
      tools.set(def.name, def);
    },
    registerCommand: (name: string, cmd: CommandDef) => {
      commands.set(name, cmd);
    },
    registerFlag: (
      name: string,
      def: { description: string; type: string; default?: unknown }
    ) => {
      flags.set(name, def);
      flagValues.set(name, def.default);
    },
    getFlag: (name: string) => flagValues.get(name),
    sendUserMessage: (msg: string, opts?: Record<string, unknown>) => {
      sentUserMessages.push({ msg, opts });
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools.splice(0, activeTools.length, ...names);
    },
    on: (
      event: string,
      handler: (event: unknown, ctx: unknown) => void | Promise<void>
    ) => {
      const arr = handlers.get(event) ?? [];
      arr.push(handler);
      handlers.set(event, arr);
    },
  };
  const extension = (
    (await import('../src/index.js')) as {
      default: (pi: unknown) => Promise<void>;
    }
  ).default;
  await extension(pi);
  return {
    tools,
    commands,
    flags,
    flagValues,
    sentUserMessages,
    handlers,
    pi,
    activeTools,
  };
}

function invokeExecute(
  tool: ToolDef,
  params: Record<string, unknown>,
  ctx: unknown = { cwd: process.cwd() }
) {
  return tool.execute('call-id', params, undefined, undefined, ctx);
}

function argValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]!);
  }
  return values;
}

function assertHasAllOctocodeSkills(skillArgs: string[]): void {
  // Assert every Octocode skill the package actually bundles (per listBundledSkills)
  // is passed to the subagent. Subset checkouts ship no skills here, so this is a
  // no-op when the package bundles none.
  const bundled = listBundledSkills(packageRoot);
  const expected = EXPECTED_OCTOCODE_SKILLS.filter(name => bundled.includes(name));
  for (const skillName of expected) {
    assert.ok(
      skillArgs.some(skillPath =>
        skillPath.endsWith(path.join('skills', skillName))
      ),
      `missing bundled skill: ${skillName}`
    );
  }
}

// ─── Build artifact tests ─────────────────────────────────────────────────────

test('build composes the system prompt from its section files', async () => {
  const paths = getAssetPaths(distDir);
  const { SYSTEM_PROMPT } = await import('../src/prompts/compose.js');
  assert.equal(fs.existsSync(paths.systemPrompt), true);
  assert.ok(SYSTEM_PROMPT.includes('<authority>'), 'sections are composed');
  assert.match(SYSTEM_PROMPT, /pi -ne --list-models/);
  assert.match(SYSTEM_PROMPT, /never hardcoded config paths/);
  assert.match(SYSTEM_PROMPT, /smallest capable configured model/);
  assert.match(SYSTEM_PROMPT, /At the start of every task, check whether the work should be decomposed/);
  assert.match(SYSTEM_PROMPT, /independent known-input reads\/checks that can run in one parallel tool batch/);
  assert.equal(
    fs.existsSync(path.join(distDir, 'prompts', 'sections', 'agents.md')),
    true
  );
  assert.equal(
    fs.existsSync(path.join(distDir, 'prompts', 'sections', 'index.ts')),
    false
  );
  assert.equal(fs.readFileSync(paths.systemPrompt, 'utf8'), SYSTEM_PROMPT);

  const sourceSections = path.join(packageRoot, 'src', 'prompts', 'sections');
  const distSections = path.join(distDir, 'prompts', 'sections');
  const sourceFiles = fs.readdirSync(sourceSections)
    .filter(file => file.endsWith('.md'))
    .sort();
  const distFiles = fs.readdirSync(distSections)
    .filter(file => file.endsWith('.md'))
    .sort();
  assert.deepEqual(distFiles, sourceFiles);
  for (const file of sourceFiles) {
    assert.equal(
      fs.readFileSync(path.join(distSections, file), 'utf8'),
      fs.readFileSync(path.join(sourceSections, file), 'utf8'),
      `dist prompt section differs from source: ${file}`
    );
  }

  for (const agent of ['architect', 'browser-agent', 'planner', 'researcher']) {
    assert.equal(
      fs.readFileSync(
        path.join(distDir, 'subagents', agent, 'SYSTEM_PROMPT.md'),
        'utf8'
      ),
      fs.readFileSync(
        path.join(packageRoot, 'subagents', agent, 'SYSTEM_PROMPT.md'),
        'utf8'
      ),
      `dist subagent prompt differs from source: ${agent}`
    );
  }
});

test('build copies bundled Octocode skills without secret env files', () => {
  assert.equal(
    path.basename(getCLIPath(distDir)),
    'octocode.js',
    'Octocode CLI resolves to an octocode.js entry (dist bundle or node_modules fallback)'
  );
  assert.equal(
    fs.existsSync(path.join(distDir, 'bin', 'octocode.js')),
    false,
    'legacy dist/bin CLI path should not be used'
  );
  assert.equal(
    fs.existsSync(path.join(distDir, 'awareness')),
    false,
    'awareness runtime assets are not copied as a separate dist/awareness directory'
  );

  const skills = listBundledSkills(distDir);
  const sourceSkills = listBundledSkills(packageRoot);
  const rootSkills = listBundledSkills(path.resolve(packageRoot, '../..'));
  assert.deepEqual(skills, sourceSkills, 'dist matches package skills');
  assert.deepEqual(
    sourceSkills,
    rootSkills,
    'every repo-root skill is staged into the npm package'
  );
  for (const skill of rootSkills) {
    assert.equal(
      fs.readFileSync(path.join(packageRoot, 'skills', skill, 'SKILL.md'), 'utf8'),
      fs.readFileSync(path.resolve(packageRoot, '../..', 'skills', skill, 'SKILL.md'), 'utf8'),
      `${skill} SKILL.md is copied from the repo-root bundle`
    );
  }
  assert.equal(
    fs.existsSync(path.join(distDir, 'skills', 'octocode-reflection')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(distDir, 'skills', 'octocode-agent-communication')),
    false
  );

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
  ) as {
    files?: string[];
    pi?: { skills?: string[] };
  };
  assert.ok(packageJson.files?.includes('skills/**'), 'npm files includes generated skills');
  assert.deepEqual(packageJson.pi?.skills, ['./skills']);
  assert.match(
    fs.readFileSync(path.resolve(packageRoot, '../..', '.gitignore'), 'utf8'),
    /^\/packages\/octocode-pi-extension\/skills\/$/m,
    'generated npm skill staging remains gitignored'
  );

  const forbiddenEnv = path.join(
    distDir,
    'skills',
    'octocode-brainstorming',
    '.env'
  );
  assert.equal(fs.existsSync(forbiddenEnv), false);
});

// ─── Functional tests ─────────────────────────────────────────────────────────

test('managed APPEND_SYSTEM block is inserted and replaced without duplication', () => {
  const first = mergeManagedAppendSystem('local rules\n', 'old octocode rules');
  assert.match(first, new RegExp(MANAGED_BLOCK_START));
  assert.match(first, new RegExp(MANAGED_BLOCK_END));

  const second = mergeManagedAppendSystem(first, 'new octocode rules');
  assert.equal(second.match(new RegExp(MANAGED_BLOCK_START, 'g'))?.length, 1);
  assert.match(second, /new octocode rules/);
  assert.doesNotMatch(second, /old octocode rules/);
});

test('argument parsing supports setup scopes and quoted installer args', () => {
  assert.equal(parseSetupScope('--global'), 'global');
  assert.equal(parseSetupScope('global'), 'global');
  assert.equal(parseSetupScope(''), 'project');
  assert.deepEqual(splitArgs('--ide "VS Code" --scope user'), [
    '--ide',
    'VS Code',
    '--scope',
    'user',
  ]);
});

test('path, asset, and output helpers cover edge cases', () => {
  assert.equal(
    getAppendSystemTarget('global', '/repo', '/home/tester'),
    path.join('/home/tester', '.pi', 'agent', 'APPEND_SYSTEM.md')
  );
  assert.deepEqual(truncateUserVisibleToolOutput('abcdef', 3), {
    text: 'abc…',
    truncated: true,
    omittedChars: 3,
  });
  assert.equal(
    readTextIfExists(path.join(os.tmpdir(), 'octocode-missing-file')),
    ''
  );
  assert.throws(() => readTextIfExists(os.tmpdir()));

  const previousAllowed = process.env['ALLOWED_PATHS'];
  const allowedViaHome = path.join(
    os.homedir(),
    'octocode-pi-allowed-does-not-exist',
    'new.txt'
  );
  try {
    process.env['ALLOWED_PATHS'] =
      `~:${path.join('~', 'octocode-pi-allowed-does-not-exist')}`;
    assert.doesNotThrow(() =>
      assertPathAllowed(allowedViaHome, packageRoot, 'test write')
    );
    assert.throws(
      () =>
        assertPathAllowed(
          path.join(
            path.parse(packageRoot).root,
            'octocode-pi-blocked-outside-root',
            'x.txt'
          ),
          packageRoot,
          'test write'
        ),
      /outside the allowed roots/
    );
  } finally {
    if (previousAllowed === undefined) delete process.env['ALLOWED_PATHS'];
    else process.env['ALLOWED_PATHS'] = previousAllowed;
  }
});

test('system prompt append guard detects existing prompt', () => {
  const octocodePrompt = 'Some Octocode system prompt content.';
  // Should append when the system prompt is empty or lacks the marker.
  assert.equal(shouldAppendSystemPrompt('', octocodePrompt), true);
  // M3: Only the SYSTEM_PROMPT_MARKER signals prior inclusion (proofSlice removed).
  // Without the marker, always append — even if content overlaps.
  assert.equal(shouldAppendSystemPrompt(octocodePrompt, octocodePrompt), true);
  // When the system prompt already carries the marker, do not append again.
  const withMarker = `Pi prompt.\n\n${SYSTEM_PROMPT_MARKER}\n${octocodePrompt}\n${SYSTEM_PROMPT_MARKER}`;
  assert.equal(shouldAppendSystemPrompt(withMarker, octocodePrompt), false);
});

test('getInstallSource returns npm source for node_modules installs, local path otherwise', () => {
  const localSource = getInstallSource();
  assert.ok(
    !localSource.startsWith('npm:'),
    `expected local path, got ${localSource}`
  );
  assert.ok(
    path.isAbsolute(localSource),
    `expected absolute path, got ${localSource}`
  );

  const fakeNpmDir = path.join(
    os.tmpdir(),
    'node_modules',
    '@octocodeai',
    'pi-extension',
    'dist'
  );
  const npmSource = getInstallSource(fakeNpmDir);
  assert.equal(npmSource, 'npm:@octocodeai/pi-extension');
});

test(
  'formatStatus reports the dist assets',
  withTempMemoryHome(() => {
    const status = formatStatus(distDir);
    assert.match(status, /system prompt: found/);
    assert.match(status, /octocode tools: 13 native Pi tools/);
    assert.match(status, /bundled CLI:.*octocode\.js/);
    assert.match(status, /internal error log: .*\.octocode\/logs\/error\.txt/);
    assert.match(
      status,
      /disabled\/replaced built-ins: overridden: edit, write, bash/
    );
    assert.match(status, /removed: read, grep, find, ls/);
    assert.doesNotMatch(status, /passthrough: bash/);
  })
);

test('disable built-in read in favor of localGetFileContent (records read state for edit stale-check)', async () => {
  const { activeTools, tools } = await captureExtensions();
  // The built-in `read` tool is removed so agents use localGetFileContent, which
  // records read state via recordFileReadState — the input the edit tool's stale
  // check relies on (see edit-tool.ts checkReadState).
  assert.equal(
    activeTools.includes('read'),
    false,
    'built-in read is disabled in favor of localGetFileContent'
  );
  assert.equal(activeTools.includes('bash'), true, 'bash remains available');
  assert.equal(
    activeTools.includes('edit'),
    true,
    'edit remains active because the custom tool overrides the built-in by name'
  );
  assert.equal(
    tools.has('localGetFileContent'),
    true,
    'localGetFileContent is registered as the canonical read tool'
  );
});

test('replaces built-in edit by custom tool override', async () => {
  const { tools } = await captureExtensions();
  const editTool = tools.get('edit')!;
  assert.equal(editTool.label, 'edit (Octocode)');
  assert.match(editTool.description!, /Replaces Pi built-in edit/);
  assert.ok(
    editTool.promptGuidelines!.some(line =>
      line.includes('replaces Pi built-in edit')
    )
  );
  const params = editTool.parameters as {
    properties: {
      edits: { items: { properties: Record<string, unknown> } };
      queries: unknown;
    };
  };
  assert.ok(
    params.properties.edits.items.properties['replaceAll'],
    'custom edit supports replaceAll'
  );
  assert.ok(
    params.properties.edits.items.properties['reasoning'],
    'custom edit supports per-edit reasoning metadata'
  );
  assert.ok(
    params.properties.edits.items.properties['matchMode'],
    'custom edit supports match modes'
  );
  assert.ok(
    params.properties.queries,
    'custom edit supports multi-file queries'
  );
});

test('replaces built-in write by custom tool override with path guard', async () => {
  const { tools, activeTools } = await captureExtensions();
  const writeTool = tools.get('write')!;
  assert.equal(writeTool.label, 'write (Octocode)');
  assert.match(writeTool.description!, /Replaces Pi built-in write/);
  assert.equal(activeTools.includes('write'), true, 'write stays active as Octocode override');
  assert.equal(activeTools.includes('read'), false);
  assert.equal(activeTools.includes('grep'), false);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-write-'));
  try {
    const target = path.join(tmp, 'nested', 'hello.txt');
    const result = await invokeExecute(writeTool, {
      path: target,
      content: 'hello from octocode write\n',
    }, { cwd: tmp });
    assert.match(result.content[0]!.text!, /Successfully wrote/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello from octocode write\n');

    // Outside allowed roots must fail (/usr is not cwd/home/tmp).
    const outside = `/usr/octocode-pi-write-should-block-${process.pid}.txt`;
    await assert.rejects(
      () => invokeExecute(writeTool, { path: outside, content: 'x' }, { cwd: tmp }),
      /write blocked|outside the allowed roots/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('write file_path alias folds via prepareArguments', async () => {
  const { tools } = await captureExtensions();
  const writeTool = tools.get('write')!;
  assert.ok(writeTool.prepareArguments);
  const folded = writeTool.prepareArguments!({
    file_path: 'a.ts',
    content: 'x',
  }) as { path: string; content: string };
  assert.equal(folded.path, 'a.ts');
});

test('write records read-state so a follow-up edit is not stale', async () => {
  const { tools } = await captureExtensions();
  const writeTool = tools.get('write')!;
  const editTool = tools.get('edit')!;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-write-edit-'));
  try {
    const target = path.join(tmp, 'seed.ts');
    await invokeExecute(
      writeTool,
      { path: target, content: 'const x = 1;\n' },
      { cwd: tmp },
    );
    const edited = await invokeExecute(
      editTool,
      {
        path: target,
        requireRecentRead: true,
        edits: [
          {
            oldText: 'const x = 1;',
            newText: 'const x = 2;',
            reasoning: 'bump after write',
          },
        ],
      },
      { cwd: tmp },
    );
    assert.match(edited.content[0]!.text!, /Successfully replaced/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'const x = 2;\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('custom edit applies batched replacements and replaceAll against original content', () => {
  const result = applyCustomEditsToContent(
    'alpha one\nbeta one\nalpha two\n',
    [
      {
        oldText: 'beta one',
        newText: 'beta two',
        reasoning: 'update the beta line only',
      },
      {
        oldText: 'alpha',
        newText: 'ALPHA',
        replaceAll: true,
        reasoning: 'rename every alpha literal',
      },
    ],
    'sample.txt'
  );

  assert.equal(result.newContent, 'ALPHA one\nbeta two\nALPHA two\n');
  assert.equal(result.replacements, 3);
  assert.equal(result.firstChangedLine, 1);
});

test('custom edit not-found errors include current-file recovery guidance', () => {
  assert.throws(
    () =>
      applyCustomEditsToContent(
        'const value = 1;\n',
        [
          {
            oldText: 'const value = 2;',
            newText: 'const value = 3;',
            reasoning: 'test',
          },
        ],
        'sample.ts'
      ),
    /Re-read the target range and retry with a smaller unique oldText/
  );
});

test('custom edit not-found diagnostics preserve visible leading whitespace in similar-line hints', () => {
  assert.throws(
    () =>
      applyCustomEditsToContent(
        '    const value = 1;\n',
        [
          {
            oldText: '      const value = 1;',
            newText: '      const value = 2;',
            reasoning: 'test indentation drift diagnostic',
          },
        ],
        'sample.ts'
      ),
    /line 1: ····const value = 1;/
  );
});

test('custom edit requires reasoning and shows it in output', async () => {
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'octocode-edit-reasoning-')
  );
  const target = path.join(tmp, 'reasoning.txt');
  fs.writeFileSync(target, 'left\nright\n', 'utf8');
  try {
    const editTool = tools.get('edit')!;
    // Missing reasoning must be rejected.
    await assert.rejects(
      () =>
        invokeExecute(editTool, {
          path: target,
          edits: [{ oldText: 'left', newText: 'LEFT' }],
        }),
      /reasoning is required/
    );

    const withReasoning = await invokeExecute(editTool, {
      path: target,
      edits: [
        {
          oldText: 'right',
          newText: 'RIGHT',
          reasoning: 'uppercase the remaining direction',
        },
      ],
    });
    assert.match(
      withReasoning.content[0]!.text,
      /Reasoning:\n- .*reasoning\.txt edits\[0\]: uppercase the remaining direction/
    );
    assert.match(
      withReasoning.content[0]!.text,
      /Changes:\n# .*reasoning\.txt/
    );
    assert.match(withReasoning.content[0]!.text, /\x1b\[31m- right\x1b\[0m/);
    assert.match(withReasoning.content[0]!.text, /\x1b\[32m\+ RIGHT\x1b\[0m/);
    // 'left' was not changed (the rejected call did not write); only 'right' was replaced.
    assert.equal(fs.readFileSync(target, 'utf8'), 'left\nRIGHT\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('custom edit returns diff and patch details', async () => {
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-edit-diff-'));
  const target = path.join(tmp, 'diff.txt');
  fs.writeFileSync(target, 'one\ntwo\n', 'utf8');
  try {
    const result = await invokeExecute(tools.get('edit')!, {
      path: target,
      edits: [
        { oldText: 'two', newText: 'TWO', reasoning: 'change to uppercase' },
      ],
    });
    const details = result.details as {
      diff: string;
      patch: string;
      files: Array<{
        patch: string;
        diff: string;
        coloredDiff: string;
        reasoning: Array<{ editIndex: number; reasoning: string }>;
      }>;
    };
    assert.match(result.content[0]!.text, /Changes:\n# .*diff\.txt/);
    assert.match(result.content[0]!.text, /\x1b\[31m- two\x1b\[0m/);
    assert.match(result.content[0]!.text, /\x1b\[32m\+ TWO\x1b\[0m/);
    assert.match(details.diff, /- two/);
    assert.match(details.diff, /\+ TWO/);
    assert.match(details.files[0]!.coloredDiff, /\x1b\[31m- two\x1b\[0m/);
    assert.deepEqual(details.files[0]!.reasoning, [
      { editIndex: 0, reasoning: 'change to uppercase' },
    ]);
    assert.match(details.patch, /^--- /m);
    assert.match(details.files[0]!.patch, /\+\+\+ .*diff\.txt/);

    const themedLines = tools.get('edit')!.renderResult!(
      result,
      { expanded: true },
      {
        bold: (text: string) => `<b>${text}</b>`,
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      }
    ).render(120);
    assert.ok(themedLines.some(line => line.includes('<error>- two</error>')));
    assert.ok(
      themedLines.some(line => line.includes('<success>+ TWO</success>'))
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('custom edit renderResult lists per-edit reasoning, red/green diff, line range, and file', async () => {
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-edit-peredit-'));
  const target = path.join(tmp, 'checkout.ts');
  // Two edits on disjoint lines so per-edit line ranges are distinct + non-overlapping.
  fs.writeFileSync(
    target,
    'import { a } from "a";\nconst x = submitOrder(payload);\nconst y = total(x);\n',
    'utf8'
  );
  try {
    const result = await invokeExecute(tools.get('edit')!, {
      path: target,
      edits: [
        {
          oldText: 'submitOrder(payload)',
          newText: 'submitOrderV2(payload)',
          reasoning: 'rename to v2 handler',
        },
        {
          oldText: 'const y = total(x);',
          newText: 'const y = sumTotal(x);',
          reasoning: 'rename total to sumTotal for clarity',
        },
      ],
    });
    const themedLines = tools.get('edit')!.renderResult!(
      result,
      { expanded: true },
      {
        bold: (text: string) => `<b>${text}</b>`,
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      }
    ).render(160);

    // The file is shown once as a group header.
    assert.ok(
      themedLines.some(
        l => /checkout\.ts/.test(l) && !l.includes('- ') && !l.includes('+ ')
      ),
      'file path shown as group header'
    );

    // Per-edit edit number + line range in the ORIGINAL file.
    assert.ok(
      themedLines.some(l => /edit #1/i.test(l)),
      'edit #1 marker present'
    );
    assert.ok(
      themedLines.some(l => /edit #2/i.test(l)),
      'edit #2 marker present'
    );
    // Edit #1 touches line 2 (the submitOrder line); edit #2 touches line 3.
    assert.ok(
      themedLines.some(l => /#1.*\b2\b/.test(l) || /\b2\b.*#1/.test(l)),
      'edit #1 carries its line number'
    );
    assert.ok(
      themedLines.some(l => /#2.*\b3\b/.test(l) || /\b3\b.*#2/.test(l)),
      'edit #2 carries its line number'
    );

    // Each edit reasoning is shown.
    assert.ok(
      themedLines.some(
        l =>
          /rename to v2 handler/.test(l) &&
          !l.includes('- ') &&
          !l.includes('+ ')
      ),
      'edit #1 reasoning shown'
    );
    assert.ok(
      themedLines.some(
        l =>
          /rename total to sumTotal for clarity/.test(l) &&
          !l.includes('- ') &&
          !l.includes('+ ')
      ),
      'edit #2 reasoning shown'
    );

    // Red/green per-edit diffs: removed and added lines for each edit appear, themed.
    assert.ok(
      themedLines.some(l =>
        l.includes('<error>- submitOrder(payload)</error>')
      ),
      'edit #1 removed line shown red'
    );
    assert.ok(
      themedLines.some(l =>
        l.includes('<success>+ submitOrderV2(payload)</success>')
      ),
      'edit #1 added line shown green'
    );
    assert.ok(
      themedLines.some(l => l.includes('<error>- const y = total(x);</error>')),
      'edit #2 removed line shown red'
    );
    assert.ok(
      themedLines.some(l =>
        l.includes('<success>+ const y = sumTotal(x);</success>')
      ),
      'edit #2 added line shown green'
    );
  } finally {
    clearEditReadStateForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── adversarial / edge-case break attempts (validate the edit tool under stress) ───

test('BREAK: edits apply to ORIGINAL content, not sequentially (2nd edit cannot match 1st edit output)', () => {
  // edit2.oldText "X" only exists AFTER edit1 runs; it is NOT in the original → must throw not-found.
  assert.throws(
    () =>
      applyCustomEditsToContent(
        'a\nb\n',
        [
          { oldText: 'a', newText: 'X', reasoning: 'first' },
          { oldText: 'X', newText: 'Y', reasoning: 'depends on first' },
        ],
        'sample.txt'
      ),
    /Could not find/
  );
});

test('BREAK: adjacent (touching) edits are NOT flagged as overlap', () => {
  // edit1 covers bytes 0-2 ("ab"), edit2 covers bytes 2-4 ("cd") — adjacent, not overlapping.
  const result = applyCustomEditsToContent(
    'abcd\n',
    [
      { oldText: 'ab', newText: 'AB', reasoning: 'first half' },
      { oldText: 'cd', newText: 'CD', reasoning: 'second half' },
    ],
    'sample.txt'
  );
  assert.equal(result.newContent, 'ABCD\n');
  assert.equal(result.replacements, 2);
});

test('BREAK: overlapping edits throw (previous.end > current.start)', () => {
  // edit1 "bcd" (bytes 1-4), edit2 "abc" (bytes 0-3) — they overlap at bytes 1-3.
  assert.throws(
    () =>
      applyCustomEditsToContent(
        'abcd\n',
        [
          { oldText: 'bcd', newText: 'X', reasoning: 'overlap a' },
          { oldText: 'abc', newText: 'Y', reasoning: 'overlap b' },
        ],
        'sample.txt'
      ),
    /overlap in/
  );
});

test('BREAK: oldText === newText is rejected as a no-op', () => {
  assert.throws(
    () =>
      applyCustomEditsToContent(
        'a\n',
        [{ oldText: 'a', newText: 'a', reasoning: 'no-op' }],
        'sample.txt'
      ),
    /No changes made/
  );
});

test('BREAK: empty newText is a deletion that produces correct evidence', () => {
  const result = applyCustomEditsToContent(
    'foo bar baz\n',
    [{ oldText: 'bar ', newText: '', reasoning: 'delete the bar token' }],
    'sample.txt'
  );
  assert.equal(result.newContent, 'foo baz\n');
  assert.equal(result.edits.length, 1);
  assert.deepEqual(result.edits[0]!.removedLines, ['bar ']);
  assert.deepEqual(result.edits[0]!.addedLines, ['']);
});

test('BREAK: replaceAll with newText containing oldText does not loop and counts original occurrences', () => {
  // 'a' -> 'aa' replaceAll: occurrences are scanned on the ORIGINAL (3 'a's), applied once each.
  const result = applyCustomEditsToContent(
    'a a a\n',
    [
      {
        oldText: 'a',
        newText: 'aa',
        replaceAll: true,
        reasoning: 'double every a',
      },
    ],
    'sample.txt'
  );
  assert.equal(result.newContent, 'aa aa aa\n');
  assert.equal(result.replacements, 3);
  assert.equal(result.edits[0]!.removedLines.length, 3);
  assert.equal(result.edits[0]!.addedLines.length, 3);
});

test('BREAK: normalized match handles NFKC ligature (ﬁ -> fi) with correct original-file offsets', () => {
  // Content has the ﬁ ligature (U+FB01); oldText uses 'fi'. NFKC normalizes ﬁ -> fi.
  // The byte offsets must index the ORIGINAL content (with ﬁ), not the normalized text.
  const result = applyCustomEditsToContent(
    'const ﬁle = 1;\n',
    [
      {
        oldText: 'const file = 1;\n',
        newText: 'const file = 2;\n',
        matchMode: 'normalized',
        reasoning: 'nfkc ligature match',
      },
    ],
    'sample.ts'
  );
  assert.equal(result.newContent, 'const file = 2;\n');
  assert.deepEqual(result.usedModes, ['normalized']);
  assert.equal(result.edits[0]!.startLine, 1);
  assert.equal(result.edits[0]!.endLine, 1);
  assert.deepEqual(result.edits[0]!.removedLines, ['const ﬁle = 1;']);
  assert.deepEqual(result.edits[0]!.addedLines, ['const file = 2;']);
});

test('BREAK: BOM + CRLF file round-trips through an edit preserving BOM and CRLF', async () => {
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-edit-bom-crlf-'));
  const target = path.join(tmp, 'win.txt');
  const bom = '\uFEFF';
  fs.writeFileSync(target, `${bom}line one\r\nline two\r\n`, 'utf8');
  try {
    await recordFileReadState(target);
    const result = await invokeExecute(tools.get('edit')!, {
      path: target,
      edits: [
        {
          oldText: 'line two',
          newText: 'LINE TWO',
          reasoning: 'uppercase line 2',
        },
      ],
    });
    const written = fs.readFileSync(target, 'utf8');
    assert.ok(written.startsWith('\uFEFF'), 'BOM preserved');
    assert.ok(written.includes('\r\n'), 'CRLF preserved');
    assert.equal(written, `${bom}line one\r\nLINE TWO\r\n`);
    assert.ok(
      (result.details as { files: Array<{ edits: unknown[] }> }).files[0]!.edits
        .length > 0,
      'per-edit evidence present'
    );
  } finally {
    clearEditReadStateForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BREAK: multi-line oldText evidence reports the full line span and all removed/added lines', () => {
  const result = applyCustomEditsToContent(
    'a\nb\nc\nd\n',
    [
      {
        oldText: 'b\nc\nd',
        newText: 'X',
        reasoning: 'collapse 3 lines into 1',
      },
    ],
    'sample.txt'
  );
  assert.equal(result.newContent, 'a\nX\n');
  assert.equal(result.edits[0]!.startLine, 2);
  assert.equal(result.edits[0]!.endLine, 4);
  assert.deepEqual(result.edits[0]!.removedLines, ['b', 'c', 'd']);
  assert.deepEqual(result.edits[0]!.addedLines, ['X']);
});

test('BREAK: lineRange with matching oldText succeeds; mismatched oldText throws', () => {
  const ok = applyCustomEditsToContent(
    'one\ntwo\nthree\n',
    [
      {
        newText: 'TWO\n',
        matchMode: 'lineRange',
        startLine: 2,
        endLine: 2,
        oldText: 'two\n',
        reasoning: 'lineRange with anchor',
      },
    ],
    'sample.txt'
  );
  assert.equal(ok.newContent, 'one\nTWO\nthree\n');

  assert.throws(
    () =>
      applyCustomEditsToContent(
        'one\ntwo\nthree\n',
        [
          {
            newText: 'TWO\n',
            matchMode: 'lineRange',
            startLine: 2,
            endLine: 2,
            oldText: 'WRONG\n',
            reasoning: 'bad anchor',
          },
        ],
        'sample.txt'
      ),
    /oldText does not match the requested line range/
  );
});

test('BREAK: multi-file edit is all-or-nothing when one query requires read state it lacks', async () => {
  clearEditReadStateForTests();
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-edit-atomic-'));
  const a = path.join(tmp, 'a.txt');
  const b = path.join(tmp, 'b.txt');
  fs.writeFileSync(a, 'A\n', 'utf8');
  fs.writeFileSync(b, 'B\n', 'utf8');
  try {
    await assert.rejects(
      () =>
        invokeExecute(tools.get('edit')!, {
          queries: [
            {
              path: a,
              requireRecentRead: true,
              edits: [{ oldText: 'A', newText: 'AA', reasoning: 'x' }],
            },
            {
              path: b,
              edits: [{ oldText: 'B', newText: 'BB', reasoning: 'x' }],
            },
          ],
        }),
      /No prior localGetFileContent read state recorded/
    );
    assert.equal(fs.readFileSync(a, 'utf8'), 'A\n', 'atomicity: a not written');
    assert.equal(fs.readFileSync(b, 'utf8'), 'B\n', 'atomicity: b not written');
  } finally {
    clearEditReadStateForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BREAK: nonexistent path rejects with a clear error and writes nothing', async () => {
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-edit-noent-'));
  const missing = path.join(tmp, 'does-not-exist.txt');
  try {
    await assert.rejects(() =>
      invokeExecute(tools.get('edit')!, {
        path: missing,
        edits: [{ oldText: 'x', newText: 'y', reasoning: 'x' }],
      })
    );
    assert.equal(
      fs.existsSync(missing),
      false,
      'no file created for a missing target'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BREAK: an already-aborted signal rejects before any file read', async () => {
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-edit-abort-'));
  const target = path.join(tmp, 'abort.txt');
  fs.writeFileSync(target, 'original\n', 'utf8');
  try {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      // invokeExecute hardcodes signal=undefined, so call execute() directly to pass the AbortSignal.
      () =>
        tools
          .get('edit')!
          .execute(
            'call-id',
            {
              path: target,
              edits: [
                { oldText: 'original', newText: 'CHANGED', reasoning: 'x' },
              ],
            },
            ctrl.signal,
            undefined,
            { cwd: process.cwd() }
          ),
      /Operation aborted/
    );
    assert.equal(
      fs.readFileSync(target, 'utf8'),
      'original\n',
      'aborted before any write'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('per-edit line numbers stay in ORIGINAL-file coordinates even when earlier edits shift line counts', () => {
  // Invariant: edits are matched against the ORIGINAL content and line numbers are
  // computed from the ORIGINAL file's line spans — so each edit's reported
  // startLine/endLine is its position BEFORE any edits, independent of other edits.
  // This matches the git/unified-diff convention (@@ -<oldStart>,<oldCount> uses OLD-file lines)
  // and what localGetFileContent showed the agent when it chose the edit.
  // Regression-lock: a future switch to cumulative/post-prior-edits coordinates must fail here.
  const original = 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n';
  const result = applyCustomEditsToContent(
    original,
    [
      {
        oldText: 'L2\n',
        newText: 'A\nB\nC\nD\n',
        reasoning:
          'expand line 2 into 4 lines (net +3, shifts everything below DOWN by 3 in the result)',
      },
      {
        oldText: 'L6\nL7\n',
        newText: 'X\n',
        reasoning: 'collapse lines 6-7 into 1 (net -1)',
      },
      {
        oldText: 'L10\n',
        newText: 'Z\n',
        reasoning: 'replace line 10 — sits BELOW all the shifting',
      },
    ],
    'sample.txt'
  );

  // Each edit reports its ORIGINAL-file line range, NOT its post-earlier-edits position.
  assert.equal(result.edits[0]!.startLine, 2); // L2 → original line 2
  assert.equal(result.edits[0]!.endLine, 2);
  assert.equal(result.edits[1]!.startLine, 6); // L6-L7 → original lines 6-7 (NOT 9-10 as cumulative would give)
  assert.equal(result.edits[1]!.endLine, 7);
  assert.equal(result.edits[2]!.startLine, 10); // L10 → original line 10 (NOT 12 as cumulative would give)
  assert.equal(result.edits[2]!.endLine, 10);

  // Evidence fidelity: removed lines are the ACTUAL original bytes, added lines the new bytes.
  assert.deepEqual(result.edits[0]!.removedLines, ['L2']);
  assert.deepEqual(result.edits[0]!.addedLines, ['A', 'B', 'C', 'D']);
  assert.deepEqual(result.edits[1]!.removedLines, ['L6', 'L7']);
  assert.deepEqual(result.edits[1]!.addedLines, ['X']);
  assert.deepEqual(result.edits[2]!.removedLines, ['L10']);
  assert.deepEqual(result.edits[2]!.addedLines, ['Z']);

  // Final content is the 3 edits applied to the original (matches, locks correctness end-to-end).
  assert.equal(
    result.newContent,
    'L1\n' + 'A\nB\nC\nD\n' + 'L3\nL4\nL5\n' + 'X\n' + 'L8\nL9\n' + 'Z\n'
  );
});

test('lineRange edit keeps ORIGINAL-file coordinates when an earlier edit inserts lines above it', () => {
  // edit0 inserts 2 lines above edit1; edit1 uses lineRange(4,4) referencing the ORIGINAL file.
  // Its reported startLine must be 4 (original), not 6 (where 'd' lands after the insert).
  const result = applyCustomEditsToContent(
    'a\nb\nc\nd\n',
    [
      {
        oldText: 'a\n',
        newText: 'X\nY\nZ\n',
        reasoning: 'insert 2 lines above',
      },
      {
        newText: 'NEW\n',
        matchMode: 'lineRange',
        startLine: 4,
        endLine: 4,
        reasoning: 'replace original line 4 (d) via lineRange',
      },
    ],
    'sample2.txt'
  );
  assert.equal(
    result.edits[1]!.startLine,
    4,
    'lineRange coords are original-file, not post-insert'
  );
  assert.equal(result.edits[1]!.endLine, 4);
  assert.equal(result.newContent, 'X\nY\nZ\nb\nc\nNEW\n');
});

test('custom edit supports normalized and lineRange match modes', () => {
  const normalized = applyCustomEditsToContent(
    'const label = “hello”;\n',
    [
      {
        oldText: 'const label = "hello";\n',
        newText: 'const label = "hi";\n',
        matchMode: 'normalized',
        reasoning: 'test normalized match',
      },
    ],
    'sample.ts'
  );
  assert.equal(normalized.newContent, 'const label = "hi";\n');
  assert.deepEqual(normalized.usedModes, ['normalized']);

  const lineRange = applyCustomEditsToContent(
    'one\ntwo\nthree\n',
    [
      {
        newText: 'TWO\n',
        matchMode: 'lineRange',
        startLine: 2,
        endLine: 2,
        reasoning: 'test lineRange match',
      },
    ],
    'sample.txt'
  );
  assert.equal(lineRange.newContent, 'one\nTWO\nthree\n');
  assert.deepEqual(lineRange.usedModes, ['lineRange']);
});

test('custom edit normalized mode tolerates leading indentation drift', () => {
  const result = applyCustomEditsToContent(
    '    const value = 1;\n',
    [
      {
        oldText: '      const value = 1;\n',
        newText: '      const value = 2;\n',
        matchMode: 'normalized',
        reasoning: 'recover from rendered indentation drift',
      },
    ],
    'sample.ts'
  );
  assert.equal(result.newContent, '      const value = 2;\n');
  assert.deepEqual(result.usedModes, ['normalized']);
});

test('custom edit supports all-or-nothing multi-file queries', async () => {
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-edit-queries-'));
  const first = path.join(tmp, 'first.txt');
  const second = path.join(tmp, 'second.txt');
  fs.writeFileSync(first, 'alpha\n', 'utf8');
  fs.writeFileSync(second, 'beta\n', 'utf8');
  try {
    await assert.rejects(
      () =>
        invokeExecute(tools.get('edit')!, {
          queries: [
            {
              path: first,
              edits: [
                { oldText: 'alpha', newText: 'ALPHA', reasoning: 'test' },
              ],
            },
            {
              path: second,
              edits: [
                { oldText: 'missing', newText: 'MISSING', reasoning: 'test' },
              ],
            },
          ],
        }),
      /Could not find/
    );
    assert.equal(fs.readFileSync(first, 'utf8'), 'alpha\n');
    assert.equal(fs.readFileSync(second, 'utf8'), 'beta\n');

    const result = await invokeExecute(tools.get('edit')!, {
      queries: [
        {
          path: first,
          edits: [{ oldText: 'alpha', newText: 'ALPHA', reasoning: 'test' }],
        },
        {
          path: second,
          edits: [{ oldText: 'beta', newText: 'BETA', reasoning: 'test' }],
        },
      ],
    });
    assert.match(result.content[0]!.text, /2 file\(s\)/);
    assert.equal(fs.readFileSync(first, 'utf8'), 'ALPHA\n');
    assert.equal(fs.readFileSync(second, 'utf8'), 'BETA\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('custom edit rejects stale files when read state was recorded', async () => {
  clearEditReadStateForTests();
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-edit-stale-'));
  const target = path.join(tmp, 'stale.txt');
  fs.writeFileSync(target, 'before\n', 'utf8');
  try {
    await recordFileReadState(target);
    fs.writeFileSync(target, 'changed elsewhere\n', 'utf8');
    await assert.rejects(
      () =>
        invokeExecute(tools.get('edit')!, {
          path: target,
          edits: [
            {
              oldText: 'changed elsewhere',
              newText: 'ours',
              reasoning: 'test',
            },
          ],
        }),
      /File changed since last recorded read/
    );
  } finally {
    clearEditReadStateForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('custom edit requireRecentRead rejects an edit with no prior read state', async () => {
  clearEditReadStateForTests();
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'octocode-edit-require-read-')
  );
  const target = path.join(tmp, 'unseen.txt');
  fs.writeFileSync(target, 'original\n', 'utf8');
  try {
    // No recordFileReadState call: missing read state.
    await assert.rejects(
      () =>
        invokeExecute(tools.get('edit')!, {
          path: target,
          edits: [
            { oldText: 'original', newText: 'CHANGED', reasoning: 'test' },
          ],
          requireRecentRead: true,
        }),
      /No prior localGetFileContent read state recorded for this file/
    );
    // The rejected edit must NOT have written the file.
    assert.equal(fs.readFileSync(target, 'utf8'), 'original\n');
  } finally {
    clearEditReadStateForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('custom edit stale check is content-hash authoritative, not mtime', async () => {
  clearEditReadStateForTests();
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-edit-hash-'));
  const target = path.join(tmp, 'same.txt');
  fs.writeFileSync(target, 'same\n', 'utf8');
  try {
    await recordFileReadState(target);
    // Re-write IDENTICAL content — mtime advances, content hash identical.
    fs.writeFileSync(target, 'same\n', 'utf8');
    const result = await invokeExecute(tools.get('edit')!, {
      path: target,
      edits: [
        {
          oldText: 'same',
          newText: 'SAME',
          reasoning: 'content-hash must win over mtime',
        },
      ],
      requireRecentRead: true,
    });
    assert.match(result.content[0]!.text, /Read state: fresh/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'SAME\n');
  } finally {
    clearEditReadStateForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('custom edit rejects a non-unique oldText without replaceAll', () => {
  assert.throws(
    () =>
      applyCustomEditsToContent(
        'dup\ndup\n',
        [{ oldText: 'dup', newText: 'DUP', reasoning: 'test' }],
        'sample.txt'
      ),
    /Found 2 occurrences/
  );
});

test('custom edit lineRange rejects an out-of-range range', () => {
  assert.throws(
    () =>
      applyCustomEditsToContent(
        'one\ntwo\n',
        [
          {
            newText: 'X\n',
            matchMode: 'lineRange',
            startLine: 1,
            endLine: 99,
            reasoning: 'test',
          },
        ],
        'sample.txt'
      ),
    /line range 1-99 is outside/
  );
});

test('custom edit generates a valid unified-diff hunk header', async () => {
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-edit-patch-'));
  const target = path.join(tmp, 'patch.txt');
  fs.writeFileSync(target, 'a\nb\nc\n', 'utf8');
  try {
    const result = await invokeExecute(tools.get('edit')!, {
      path: target,
      edits: [{ oldText: 'b', newText: 'B', reasoning: 'change line 2' }],
    });
    const details = result.details as { patch: string };
    // A valid unified-diff hunk header is @@ -<start>,<count> +<start>,<count> @@ (or @@ ... @@).
    assert.match(details.patch, /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('registers all Octocode direct tools as native Pi tools', async () => {
  const { tools } = await captureExtensions();
  assert.deepEqual(
    OCTOCODE_DIRECT_TOOL_NAMES.filter(toolName => !tools.has(toolName)),
    [],
    'every direct Octocode tool is registered as a Pi tool'
  );
  assert.equal(OCTOCODE_DIRECT_TOOL_NAMES.length, 13);
  assert.ok(
    !OCTOCODE_DIRECT_TOOL_NAMES.includes('unzip' as never),
    'unzip is not a native Pi tool — use npx octocode unzip via bash'
  );

  for (const toolName of OCTOCODE_DIRECT_TOOL_NAMES) {
    const tool = tools.get(toolName)!;
    assert.equal(tool.name, toolName);
    assert.ok(tool.label, `${toolName} has a label`);
    assert.ok(tool.description, `${toolName} has a description`);
    assert.ok(tool.promptSnippet, `${toolName} has a prompt snippet`);
    assert.equal(
      (tool.parameters as Record<string, unknown>)['type'],
      'object',
      `${toolName} exposes an object schema`
    );
    assert.ok(
      (tool.parameters as { properties?: Record<string, unknown> }).properties,
      `${toolName} exposes schema properties`
    );
    assert.equal(
      typeof tool.execute,
      'function',
      `${toolName} has an executor`
    );
    assert.equal(
      typeof tool.renderCall,
      'function',
      `${toolName} has a call renderer`
    );
    assert.equal(
      typeof tool.renderResult,
      'function',
      `${toolName} has a result renderer`
    );
  }

  const localViewStructure = tools.get('localViewStructure')!;
  assert.equal(localViewStructure.label, 'Local Code: Local View Structure');
  const props = (
    localViewStructure.parameters as { properties: Record<string, unknown> }
  ).properties;
  assert.ok(props['queries'], 'bulk CLI tool schema exposed to Pi');
  const queriesItems = (
    props['queries'] as {
      items: { properties: Record<string, { maximum?: number }> };
    }
  ).items;
  assert.equal(queriesItems.properties['itemsPerPage']?.maximum, 50);
  assert.equal(typeof localViewStructure.renderCall, 'function');
  assert.equal(typeof localViewStructure.renderResult, 'function');

  const theme = {
    bold: (text: string) => `**${text}**`,
    fg: (_color: string, text: string) => text,
  };
  assert.deepEqual(
    localViewStructure.renderCall!({ queries: [{ path: packageRoot }] }, theme)
      .render(80)[0]!
      .includes('localViewStructure'),
    true
  );
  assert.deepEqual(
    localViewStructure.renderResult!(
      {
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
        details: { results: [1, 2] },
      },
      { expanded: false },
      theme
    ).render(80)[0],
    '✓ localViewStructure · 2 queries · expand for full output'
  );
  // Build 30 newline-separated lines so the 25-line limit is exceeded (5 lines omitted).
  const manyLines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join(
    '\n'
  );
  const expanded = localViewStructure.renderResult!(
    {
      isError: false,
      content: [{ type: 'text', text: manyLines }],
      details: {},
    },
    { expanded: true },
    theme
  ).render(80);
  // expanded[0] = header, expanded[1..25] = first 25 content lines, expanded[26] = notice
  assert.equal(
    expanded.length,
    27,
    'header + 25 content lines + 1 truncation notice'
  );
  // render(80) must respect the width contract: every line's visible width ≤ 80.
  const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
  const previewVisibleWidth = expanded[1]!.replace(ANSI_RE, '').length;
  assert.ok(
    previewVisibleWidth <= 80,
    `expanded preview line visible width (${previewVisibleWidth}) must not exceed render width 80`
  );
  // Last element is the line-based truncation notice (30 − 25 = 5 lines omitted)
  assert.match(expanded[26]!, /5 more lines? hidden/);
  // A single long line (> render width) must still be truncated with an ellipsis
  const singleLineLong = localViewStructure.renderResult!(
    {
      isError: false,
      content: [{ type: 'text', text: 'x'.repeat(450) }],
      details: {},
    },
    { expanded: true },
    theme
  ).render(80);
  assert.ok(
    singleLineLong[1]!.includes('\u2026'),
    'long single line is ellipsis-truncated at render width'
  );
});

test('browserAgent can build a typed browser subagent config without launching Chrome', async () => {
  const { tools } = await captureExtensions();
  const browserTool = tools.get('browserAgent')!;
  assert.ok(browserTool, 'browserAgent registered');

  const result = await invokeExecute(browserTool, {
    task: 'audit security cookies and auth storage',
    url: 'https://example.com/account',
    port: 19333,
    runNow: false,
  });

  const text = result.content[0]!.text;
  assert.match(text, /schemes run: \(none\)/);
  assert.match(text, /cdp domains: Network, Runtime, DOM, DOMDebugger/);
  assert.match(text, /tools: chromeDebug/);
  assert.match(text, /Your ONLY browser tool is `chromeDebug`/);
  assert.match(text, /=== SYSTEM PROMPT \(pass to spawnAgent\) ===/);
  assert.match(text, /## Target URL\nhttps:\/\/example\.com\/account/);

  const collapsed = browserTool.renderResult!(result, {
    expanded: false,
  }).render(120)[0]!;
  assert.match(collapsed, /browserAgent/);
  assert.match(collapsed, /schemes run/);
});

test('applies Octocode Pi UI status and hidden thinking label', () => {
  const calls: Array<[string, ...string[]]> = [];
  // hasUI:true is required: applyOctocodeUi guards setStatus/setHiddenThinkingLabel
  // with ctx.hasUI because they are TUI/RPC-mode features.
  applyOctocodeUi({
    hasUI: true,
    ui: {
      theme: {
        fg: (_color: string, text: string) => `<${text}>`,
        bold: (t: string) => t,
      },
      setHiddenThinkingLabel: (label: string) =>
        calls.push(['thinking', label]),
      setTitle: (title: string) => calls.push(['title', title]),
      setHeader: (factory: unknown) => {
        const component = (factory as (tui: unknown, theme: unknown) => { render: (w?: number) => string[] })(undefined, {
          fg: (_color: string, text: string) => `<${text}>`,
          bold: (t: string) => t,
        });
        calls.push(['header', component.render(120).join(' | ')]);
      },
      setStatus: (key: string, value: string) =>
        calls.push(['status', key, value]),
      setWorkingIndicator: (indicator: { frames: string[]; intervalMs?: number }) =>
        calls.push(['indicator', indicator.frames.join(''), String(indicator.intervalMs)]),
      setWorkingMessage: (message?: string) => calls.push(['working', message ?? '']),
    },
  });
  assert.deepEqual(calls, [
    ['thinking', 'Octocode thinking'],
    ['title', 'Octocode Agent'],
    ['header', '<◆ Octocode Agent> | <local/GitHub/npm/LSP/chrome/browser/agents> | <Try /octocode · /octocode-agents · /octocode-status>'],
    ['status', 'octocode', '<◆ Octocode>'],
    ['status', 'octocode-thinking', '<thinking: unknown model>'],
    ['indicator', '<✦><✧><✶><✧>', '220'],
    ['working', '🐙 Octocode thinking…'],
  ]);
  assert.equal(
    getThinkingStatus({ model: { id: 'gpt-5.5', reasoning: false } }, 'high'),
    'thinking: off (gpt-5.5 has reasoning:false)'
  );
  assert.equal(
    getThinkingStatus({ model: { id: 'claude', reasoning: true } }, 'high'),
    'thinking: high (claude)'
  );
});

test('formats Octocode metrics with context tokens and timing', () => {
  const metrics = formatOctocodeMetrics(
    { getContextUsage: () => ({ tokens: 12_345, contextWindow: 200_000 }) },
    {
      sessionStartedAt: 1_000,
      activeTurnStartedAt: 4_000,
      completedTurns: 2,
    },
    65_000
  );

  assert.equal(metrics, 'ctx ░░░░░░░░░░ 6% (12.3k/200k) · turns 2 · active 1m1s · session 1m4s');
  assert.equal(
    formatOctocodeMetrics(undefined, { sessionStartedAt: 0, completedTurns: 0 }, 500),
    'ctx n/a · turns 0 · last n/a · session 500ms'
  );
});

test('Octocode metrics status updates on session and turn lifecycle', async () => {
  const { handlers } = await captureExtensions();
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = {
    hasUI: true,
    getContextUsage: () => ({ tokens: 50_000, contextWindow: 100_000 }),
    ui: {
      theme: {
        fg: (color: string, text: string) => `<${color}:${text}>`,
        bold: (text: string) => text,
      },
      setHiddenThinkingLabel: () => undefined,
      setTitle: () => undefined,
      setStatus: (key: string, value: string | undefined) => statusCalls.push([key, value]),
      setWorkingIndicator: () => undefined,
      setWorkingMessage: () => undefined,
    },
  };

  await handlers.get('session_start')![0]!(undefined, ctx);
  assert.ok(statusCalls.some(([key, value]) => key === 'octocode-metrics' && /ctx ▓▓▓▓▓░░░░░ 50% \(50k\/100k\)/.test(value ?? '')));

  const turnStart = handlers.get('turn_start')!.at(-1)!;
  const turnEnd = handlers.get('turn_end')!.at(-1)!;
  await turnStart(undefined, ctx);
  await turnEnd(undefined, ctx);

  const latestMetrics = [...statusCalls].reverse().find(([key]) => key === 'octocode-metrics')?.[1] ?? '';
  assert.match(latestMetrics, /turns 1/);
  assert.match(latestMetrics, /last \d+(ms|s)/);
});

test('Octocode dashboard command summarizes status, agents, setup, skills, and help', async () => {
  const { commands } = await captureExtensions();
  const notices: Array<{ message: string; level?: string }> = [];
  const ctx = {
    hasUI: true,
    cwd: packageRoot,
    getContextUsage: () => ({ tokens: 75_000, contextWindow: 100_000 }),
    ui: {
      notify: (message: string, level?: string) => notices.push({ message, level }),
    },
  };

  assert.equal(commands.has('octocode'), true, 'top-level /octocode command is registered');
  await commands.get('octocode')!.handler('', ctx);

  assert.equal(notices.at(-1)?.level, 'info');
  const dashboard = notices.at(-1)?.message ?? '';
  assert.match(dashboard, /^◆ Octocode dashboard/m);
  assert.match(dashboard, /Status/);
  assert.match(dashboard, /Agents/);
  assert.match(dashboard, /Setup/);
  assert.match(dashboard, /Skills/);
  assert.match(dashboard, /Next actions/);
  assert.match(dashboard, /\/octocode-agents/);
});

test('formatOctocodeDashboard is scan-friendly and includes health warnings', () => {
  const dashboard = formatOctocodeDashboard({
    getContextUsage: () => ({ tokens: 92_000, contextWindow: 100_000 }),
    cwd: packageRoot,
  });

  assert.match(dashboard, /^◆ Octocode dashboard/m);
  assert.match(dashboard, /ctx ▓▓▓▓▓▓▓▓▓░ 92%/);
  assert.match(dashboard, /⚠ context above 90%/);
  assert.match(dashboard, /CLI:/);
  assert.match(dashboard, /\/octocode-status/);
});

test('CLI slash commands removed — extension commands are lean', async () => {
  const { commands } = await captureExtensions();
  // Extension-only commands still registered.
  assert.equal(
    commands.has('octocode'),
    true,
    'friendly dashboard command is registered'
  );
  assert.equal(
    commands.has('octocode-status'),
    true,
    'extension status command is preserved'
  );
  assert.equal(
    commands.has('octocode-harness'),
    true,
    'harness listing command is registered'
  );
  assert.equal(
    commands.has('octocode-setup'),
    true,
    'setup command is registered'
  );
  assert.equal(
    commands.has('octocode-skills-update'),
    true,
    'skills-update command is registered'
  );
  assert.deepEqual(
    listExtensionHarness().extensionCommands,
    ['/octocode', '/octocode-status', '/octocode-harness', '/octocode-agents', '/octocode-setup', '/octocode-skills-update'],
    'harness inventory lists every public Octocode slash command'
  );
  assert.equal(commands.has('octocode-memory-digest'), false, 'legacy memory digest command removed');
  assert.equal(commands.has('octocode-memory-forget'), false, 'legacy memory forget command removed');
  // Session-control internal trampoline stays for manage_context type:"new" path.
  assert.equal(
    commands.has('_octocode-handoff-impl'),
    false,
    'legacy handoff command removed'
  );
  assert.equal(
    commands.has('_octocode-clear-context-impl'),
    true,
    'internal clear command registered for command-context session control'
  );
  // CLI slash commands are gone — users use `npx octocode` instead.
  assert.equal(
    commands.has('octocode-cli'),
    false,
    'generic CLI escape hatch removed'
  );
  assert.equal(
    commands.has('octocode-cli-status'),
    false,
    'CLI status slash command removed'
  );
  assert.equal(
    commands.has('octocode-search'),
    false,
    'CLI search slash command removed'
  );
  assert.equal(
    commands.has('octocode-auth'),
    false,
    'CLI auth slash command removed'
  );
});

test('disableBuiltinReadTool is defensive and only removes disabled built-ins', () => {
  type DisablePi = Parameters<typeof disableBuiltinReadTool>[0];
  assert.equal(disableBuiltinReadTool({} as DisablePi), false);
  assert.equal(
    disableBuiltinReadTool({
      getActiveTools: () => ['bash', 'edit'],
      setActiveTools: () => {
        throw new Error('should not be called');
      },
    } as unknown as DisablePi),
    false
  );

  const active = ['read', 'bash', 'edit', 'grep', 'find', 'ls', 'write'];
  assert.equal(
    disableBuiltinReadTool({
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => {
        active.splice(0, active.length, ...names);
      },
    } as DisablePi),
    true
  );
  assert.deepEqual(active, ['bash', 'edit', 'write']);

  assert.equal(
    disableBuiltinReadTool({
      getActiveTools: () => {
        throw new Error('Extension runtime not initialized');
      },
      setActiveTools: () => undefined,
    } as unknown as DisablePi),
    false
  );
  // L7: All errors from the Pi active-tool API are now swallowed (logged + return false)
  // so a renamed/changed error message cannot crash the extension load.
  assert.equal(
    disableBuiltinReadTool({
      getActiveTools: () => {
        throw new Error('unexpected runtime failure');
      },
      setActiveTools: () => undefined,
    } as unknown as DisablePi),
    false,
  );
});

test('extension commands and lifecycle handlers execute user-visible wiring paths', async () => {
  const { commands, flags, flagValues, handlers, sentUserMessages } =
    await captureExtensions();
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const widgets: Array<[string, unknown]> = [];
  const working: Array<{ kind: 'message'; value?: string } | { kind: 'visible'; value: boolean }> = [];
  let reloads = 0;
  let confirmAnswer = false;
  const ctx = {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-extension-wiring-')),
    hasUI: true,
    model: { id: 'gpt-test', reasoning: true },
    isProjectTrusted: async () => false,
    reload: async () => {
      reloads += 1;
    },
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
      notify: (message: string, level?: string) =>
        notifications.push({ message, level }),
      confirm: async () => confirmAnswer,
      setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
      setWidget: (key: string, value: unknown) => widgets.push([key, value]),
      setWorkingMessage: (message?: string) =>
        working.push({ kind: 'message', value: message }),
      setWorkingVisible: (visible: boolean) =>
        working.push({ kind: 'visible', value: visible }),
      setHiddenThinkingLabel: (label: string) =>
        statuses.push(['hidden-thinking', label]),
    },
  };

  try {
    assert.equal(flags.get('no-context')?.default, false);

    await commands.get('octocode-status')!.handler('', ctx);
    assert.match(notifications.at(-1)!.message, /Octocode Pi extension/);

    await commands.get('octocode-harness')!.handler('', ctx);
    assert.match(notifications.at(-1)!.message, /native tools/);
    assert.match(notifications.at(-1)!.message, /builtin overrides: edit, write, bash/);
    assert.match(notifications.at(-1)!.message, /builtin removed: read, grep, find, ls/);
    assert.match(notifications.at(-1)!.message, /builtin passthrough: \(none\)/);

    await commands.get('octocode-setup')!.handler('', { ...ctx, hasUI: false });
    assert.match(
      notifications.at(-1)!.message,
      /Missing Octocode system prompt/
    );

    await commands.get('octocode-skills-update')!.handler('', ctx);
    assert.equal(
      sentUserMessages.length,
      0,
      'cancelled update does not queue follow-up'
    );
    assert.equal(notifications.at(-1)!.message, 'Command cancelled.');

    confirmAnswer = true;
    await commands.get('octocode-skills-update')!.handler('', ctx);
    assert.equal(sentUserMessages.at(-1)!.opts?.['deliverAs'], 'followUp');
    assert.match(sentUserMessages.at(-1)!.msg, /^pi update /);
    assert.equal(reloads, 1);

    const resourcesResult = await handlers.get('resources_discover')![0]!(
      undefined,
      ctx
    );
    assert.deepEqual(
      resourcesResult,
      {},
      'source-mode tests have no src/skills directory'
    );

    flagValues.set('no-context', true);
    const beforeStartEvent = {
      systemPrompt: 'already-running',
      systemPromptOptions: { contextFiles: ['AGENTS.md'] },
    };
    const beforeStartResult = await handlers.get('before_agent_start')!.at(-1)!(
      beforeStartEvent,
      ctx
    );
    assert.deepEqual(beforeStartEvent.systemPromptOptions.contextFiles, []);
    assert.equal(
      beforeStartResult,
      undefined,
      'source-mode missing generated prompt skips prompt injection'
    );

    await handlers.get('session_start')![0]!(undefined, ctx);
    await handlers.get('model_select')![0]!(undefined, ctx);
    await handlers.get('thinking_level_select')![0]!({ level: 'low' }, ctx);
    assert.ok(statuses.some(([key]) => key === 'octocode'));
    assert.ok(
      statuses.some(
        ([key, value]) =>
          key === 'octocode-thinking' && value?.includes('thinking: low')
      )
    );

    await handlers.get('session_shutdown')![0]!({ reason: 'new' }, ctx);
    assert.ok(statuses.some(([key, value]) => key === 'agent-wait' && value === undefined));
    assert.ok(statuses.some(([key, value]) => key === 'chrome-debug' && value === undefined));
    assert.ok(widgets.some(([key, value]) => key === 'octocode-agents' && value === undefined));
    assert.deepEqual(working.at(-2), { kind: 'message', value: undefined });
    assert.deepEqual(working.at(-1), { kind: 'visible', value: false });
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test('extension lifecycle notifications fall back to console outside UI contexts', async () => {
  const { commands } = await captureExtensions();
  const infos: string[] = [];
  const originalInfo = console.info;
  console.info = (message?: unknown) => {
    infos.push(String(message));
  };
  try {
    await commands.get('octocode-status')!.handler('', undefined);
    assert.ok(infos.some((message) => /\[octocode:info\].*Octocode Pi extension/.test(message)));
  } finally {
    console.info = originalInfo;
  }
});

test('extension logs rich internal errors to repo .octocode/logs/error.txt', async () => {
  const { commands, handlers } = await captureExtensions();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-error-log-'));
  const logPath = getInternalErrorLogPath(tmp);
  try {
    await commands.get('_octocode-clear-context-impl')!.handler('', { cwd: tmp, mode: 'tui' });
    await handlers.get('tool_execution_start')!.at(-1)!({
      toolCallId: 'call-1',
      toolName: 'exampleTool',
    }, { cwd: tmp, mode: 'tui', model: { id: 'test-model', reasoning: true } });
    await handlers.get('tool_execution_end')!.at(-1)!({
      toolCallId: 'call-1',
      toolName: 'exampleTool',
      result: {
        isError: true,
        message: 'bad tool token=secret-value',
        authorization: 'Bearer abc123',
      },
      isError: true,
    }, {
      cwd: tmp,
      mode: 'tui',
      model: { id: 'test-model', reasoning: true },
      getContextUsage: () => ({ tokens: 50, contextWindow: 100 }),
    });
    await handlers.get('before_provider_request')!.at(-1)!({ payload: {} }, { cwd: tmp, mode: 'tui' });
    await handlers.get('after_provider_response')!.at(-1)!({
      status: 429,
      headers: { authorization: 'Bearer should-redact', 'x-ratelimit-remaining': '0' },
    }, { cwd: tmp, mode: 'tui' });

    const text = fs.readFileSync(logPath, 'utf8');
    assert.match(text, /=== Octocode Pi Extension Error ===/);
    assert.match(text, /timestamp:/);
    assert.match(text, /uptimeMs:/);
    assert.match(text, /cwd: /);
    assert.match(text, /mode: tui/);
    assert.match(text, /model: test-model/);
    assert.match(text, /context: 50\/100 \(50%\)/);
    assert.match(text, /source: notify/);
    assert.match(text, /source: tool_execution_end/);
    assert.match(text, /source: after_provider_response/);
    assert.match(text, /durationMs:/);
    assert.match(text, /stack:/);
    assert.doesNotMatch(text, /secret-value/);
    assert.doesNotMatch(text, /should-redact/);
    assert.match(text, /\[REDACTED\]/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('manage_context type:compact queues a continuation after compaction completes', async () => {
  const { tools, sentUserMessages } = await captureExtensions();
  const compactTool = tools.get('manage_context')!;
  let compactOptions: {
    customInstructions?: string;
    onComplete?: (opts?: unknown) => void;
    onError?: (err: Error) => void;
  } = {};
  const notifications: Array<{ message: string; level: string }> = [];
  const working: Array<{ kind: 'message'; value?: string } | { kind: 'visible'; value: boolean }> = [];

  const result = await invokeExecute(
    compactTool,
    { type: 'compact', instructions: 'focus on recent file changes' },
    {
      hasUI: true,
      compact: (options: typeof compactOptions) => {
        compactOptions = options;
      },
      ui: {
        notify: (message: string, level: string) =>
          notifications.push({ message, level }),
        setWorkingMessage: (message?: string) =>
          working.push({ kind: 'message', value: message }),
        setWorkingVisible: (visible: boolean) =>
          working.push({ kind: 'visible', value: visible }),
      },
    }
  );

  assert.match(
    result.content[0]!.text,
    /will continue after the summary is saved/
  );
  assert.equal(
    compactOptions.customInstructions,
    'focus on recent file changes'
  );
  assert.equal(
    sentUserMessages.length,
    0,
    'no follow-up before compaction completes'
  );

  compactOptions.onComplete?.();
  assert.equal(sentUserMessages.length, 1);
  assert.match(sentUserMessages[0]!.msg, /Continue from the compacted context/);
  assert.equal(sentUserMessages[0]!.opts?.['deliverAs'], 'followUp');
  assert.deepEqual(notifications[0], {
    message: 'Compaction completed. Continuing from the compacted context.',
    level: 'info',
  });
  assert.deepEqual(working, [
    { kind: 'message', value: undefined },
    { kind: 'visible', value: false },
  ]);
});

test('manage_context type:compact treats empty-session compaction as a no-op', async () => {
  const { tools, sentUserMessages } = await captureExtensions();
  const compactTool = tools.get('manage_context')!;
  let compactOptions: { onError?: (err: Error) => void } = {};
  const notifications: Array<{ message: string; level: string }> = [];
  const working: Array<{ kind: 'message'; value?: string } | { kind: 'visible'; value: boolean }> = [];

  await invokeExecute(
    compactTool,
    { type: 'compact' },
    {
      hasUI: true,
      compact: (options: typeof compactOptions) => {
        compactOptions = options;
      },
      ui: {
        notify: (message: string, level: string) =>
          notifications.push({ message, level }),
        setWorkingMessage: (message?: string) =>
          working.push({ kind: 'message', value: message }),
        setWorkingVisible: (visible: boolean) =>
          working.push({ kind: 'visible', value: visible }),
      },
    }
  );

  compactOptions.onError?.(new Error('Nothing to compact'));
  assert.equal(sentUserMessages.length, 0);
  assert.deepEqual(notifications[0], {
    message: 'Compaction skipped: session is too small to compact.',
    level: 'info',
  });
  assert.deepEqual(working, [
    { kind: 'message', value: undefined },
    { kind: 'visible', value: false },
  ]);
});

test('manage_context type:new, missing compact support, and render states are explicit', async () => {
  const { tools, sentUserMessages } = await captureExtensions();
  const compactTool = tools.get('manage_context')!;

  const newResult = await invokeExecute(compactTool, { type: 'new' });
  assert.match(newResult.content[0]!.text, /New session queued/);
  assert.deepEqual(sentUserMessages.at(-1), {
    msg: '/_octocode-clear-context-impl',
    opts: { deliverAs: 'followUp' },
  });

  await assert.rejects(
    () => invokeExecute(compactTool, { type: 'compact' }, {}),
    /ctx\.compact is not available/
  );

  assert.match(
    compactTool.renderCall!(
      { type: 'new' },
      {
        bold: (text: string) => `<b>${text}</b>`,
        fg: (_color: string, text: string) => text,
      }
    ).render(120)[0]!,
    /manage_context<\/b> \(new\)/
  );
  assert.equal(
    compactTool.renderResult!(
      { isError: false, content: [{ type: 'text', text: 'ok' }] },
      { isPartial: true }
    ).render(120)[0],
    'Processing…'
  );
  assert.equal(
    compactTool.renderResult!(
      { isError: true, content: [{ type: 'text', text: 'bad' }] },
      { expanded: false }
    ).render(120)[0],
    '✗ manage_context'
  );

  const { commands } = await captureExtensions();
  const notifications: Array<{ message: string; level?: string }> = [];
  await commands.get('_octocode-clear-context-impl')!.handler('', {
    ui: {
      notify: (message: string, level?: string) =>
        notifications.push({ message, level }),
    },
  });
  assert.match(notifications.at(-1)!.message, /ctx\.newSession not available/);

  const cancelled: Array<{ message: string; level?: string }> = [];
  await commands.get('_octocode-clear-context-impl')!.handler('', {
    newSession: async () => ({ cancelled: true }),
    ui: {
      notify: (message: string, level?: string) =>
        cancelled.push({ message, level }),
    },
  });
  assert.deepEqual(cancelled.at(-1), {
    message: 'clear_context: session switch was cancelled.',
    level: 'warning',
  });
});

test('manage_context type:new returns isError when called inside a spawned worker', async () => {
  // The /_octocode-clear-context-impl command is registered only in the host Pi
  // process. Sending it from inside a worker would silently fail as an unknown
  // command. Verify the guard returns a clear error instead.
  const { tools } = await captureExtensions();
  const compactTool = tools.get('manage_context')!;
  const prev = process.env['OCTOCODE_PI_SUBAGENT'];
  process.env['OCTOCODE_PI_SUBAGENT'] = '1';
  try {
    const result = await invokeExecute(compactTool, { type: 'new' });
    assert.equal(result.isError, true, 'must be flagged as an error in worker context');
    assert.match(
      result.content[0]!.text,
      /not supported inside a spawned worker/
    );
  } finally {
    if (prev === undefined) {
      delete process.env['OCTOCODE_PI_SUBAGENT'];
    } else {
      process.env['OCTOCODE_PI_SUBAGENT'] = prev;
    }
  }
});

test('turn_end auto-compact queues a continuation after compaction completes (no stuck agent)', async () => {
  const { handlers, sentUserMessages } = await captureExtensions();
  const turnEndHandlers = handlers.get('turn_end');
  assert.ok(
    turnEndHandlers && turnEndHandlers.length > 0,
    'turn_end handler registered by extension'
  );
  const handler = turnEndHandlers![0]!;

  let compactOptions: {
    onComplete?: (opts?: unknown) => void;
    onError?: (err: Error) => void;
  } = {};
  const notifications: Array<{ message: string; level?: string }> = [];
  const working: Array<{ kind: 'message'; value?: string } | { kind: 'visible'; value: boolean }> = [];
  const ctx = (usage: { tokens: number; contextWindow: number }) => ({
    hasUI: true,
    getContextUsage: () => usage,
    compact: (options: typeof compactOptions) => {
      compactOptions = options;
    },
    ui: {
      notify: (message: string, level?: string) =>
        notifications.push({ message, level }),
      setWorkingMessage: (message?: string) =>
        working.push({ kind: 'message', value: message }),
      setWorkingVisible: (visible: boolean) =>
        working.push({ kind: 'visible', value: visible }),
    },
  });

  // Sub-threshold: must NOT trigger compaction.
  await handler(undefined, ctx({ tokens: 100, contextWindow: 1000 }));
  assert.ok(
    compactOptions.onComplete === undefined,
    'no compaction below 80% threshold'
  );

  // Rising edge across 80%: triggers ctx.compact(); capture options, fire onComplete.
  await handler(undefined, ctx({ tokens: 810, contextWindow: 1000 }));
  // Read into a fresh local with an explicit union type so prior assert.ok(...) === undefined
  // narrowing of the property cannot collapse it to `never` on a non-null call.
  const onComplete = compactOptions.onComplete as
    ((opts?: unknown) => void) | undefined;
  assert.ok(
    typeof onComplete === 'function',
    'compaction triggered at 81% rising edge'
  );
  assert.deepEqual(notifications[0], {
    message: 'Auto-compacting: context at 81% of context window.',
    level: 'info',
  });
  assert.equal(
    sentUserMessages.length,
    0,
    'no continuation queued before onComplete fires'
  );

  onComplete!();
  assert.equal(
    sentUserMessages.length,
    1,
    'followUp queued after auto-compaction completes (prevents stuck agent)'
  );
  assert.match(
    sentUserMessages[0]!.msg,
    /Auto-compaction complete.*continue the user task/i
  );
  assert.equal(sentUserMessages[0]!.opts?.['deliverAs'], 'followUp');
  assert.deepEqual(notifications[1], {
    message: 'Auto-compaction complete. Resuming…',
    level: 'info',
  });
  assert.deepEqual(working, [
    { kind: 'message', value: undefined },
    { kind: 'visible', value: false },
  ]);
});

test('turn_end auto-compact reports errors without queueing a continuation', async () => {
  const { handlers, sentUserMessages } = await captureExtensions();
  const handler = handlers.get('turn_end')![0]!;
  let compactOptions: {
    onComplete?: (opts?: unknown) => void;
    onError?: (err: Error) => void;
  } = {};
  const notifications: Array<{ message: string; level?: string }> = [];
  const working: Array<{ kind: 'message'; value?: string } | { kind: 'visible'; value: boolean }> = [];

  await handler(undefined, {
    hasUI: true,
    getContextUsage: () => ({ tokens: 850, contextWindow: 1000 }),
    compact: (options: typeof compactOptions) => {
      compactOptions = options;
    },
    ui: {
      notify: (message: string, level?: string) =>
        notifications.push({ message, level }),
      setWorkingMessage: (message?: string) =>
        working.push({ kind: 'message', value: message }),
      setWorkingVisible: (visible: boolean) =>
        working.push({ kind: 'visible', value: visible }),
    },
  });

  const onError = compactOptions.onError as (err: Error) => void;
  onError(new Error('Nothing to compact'));
  assert.equal(
    sentUserMessages.length,
    0,
    'no continuation on empty-session compaction'
  );
  assert.deepEqual(notifications[1], {
    message: 'Auto-compaction skipped: session is too small to compact.',
    level: 'info',
  });

  onError(new Error('summary request failed'));
  assert.deepEqual(notifications[2], {
    message: 'Auto-compaction failed: summary request failed',
    level: 'error',
  });
  assert.deepEqual(working, [
    { kind: 'message', value: undefined },
    { kind: 'visible', value: false },
    { kind: 'message', value: undefined },
    { kind: 'visible', value: false },
  ]);
});

test('turn_end auto-compact warns instead of silently no-oping when compact is unavailable', async () => {
  const { handlers, sentUserMessages } = await captureExtensions();
  const handler = handlers.get('turn_end')![0]!;
  const notifications: Array<{ message: string; level?: string }> = [];

  await handler(undefined, {
    hasUI: true,
    getContextUsage: () => ({ tokens: 850, contextWindow: 1000 }),
    ui: {
      notify: (message: string, level?: string) =>
        notifications.push({ message, level }),
    },
  });

  assert.deepEqual(notifications.at(-1), {
    message: 'Auto-compaction skipped: ctx.compact is not available in this runtime.',
    level: 'warning',
  });
  assert.equal(sentUserMessages.length, 0);
});

test('lists every extension harness surface', () => {
  const harness = listExtensionHarness(distDir);
  assert.deepEqual(harness.tools, OCTOCODE_DIRECT_TOOL_NAMES);
  assert.deepEqual(harness.supportTools, OCTOCODE_SUPPORT_TOOL_NAMES);
  assert.deepEqual(harness.overriddenBuiltins, ['edit', 'write', 'bash']);
  assert.deepEqual(harness.disabledBuiltins, ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(harness.passthroughBuiltins, []);
  assert.ok(harness.extensionCommands.includes('/octocode-harness'));
  assert.match(
    harness.cliNote,
    /bundled CLI.*octocode\.js/,
    'cliNote shows bundled CLI path'
  );
  assert.ok(!('cliCommands' in harness), 'cliCommands removed from harness');
});

test('README lists every harness surface exposed by the extension', () => {
  const readme = fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
  const harness = listExtensionHarness(distDir);
  const missing: string[] = [];

  for (const toolName of harness.tools) {
    if (!readme.includes(`\`${toolName}\``))
      missing.push(`native tool ${toolName}`);
  }
  for (const toolName of harness.supportTools) {
    if (!readme.includes(`\`${toolName}\``))
      missing.push(`support tool ${toolName}`);
  }
  for (const command of harness.extensionCommands) {
    if (!readme.includes(`\`${command}`))
      missing.push(`extension command ${command}`);
  }
  for (const skill of harness.skills) {
    if (!readme.includes(`\`${skill}\``)) missing.push(`skill ${skill}`);
  }

  assert.deepEqual(missing, []);
});

test('native Octocode local tool executes through the Pi tool wrapper', async () => {
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(
    path.join(packageRoot, '.octocode-pi-local-tool-')
  );
  try {
    fs.writeFileSync(path.join(tmp, 'example.txt'), 'hello', 'utf8');
    const result = await invokeExecute(
      tools.get('localViewStructure')!,
      { queries: [{ path: tmp, filesOnly: true }] },
      { cwd: packageRoot }
    );

    assert.ok(Array.isArray(result.content));
    assert.equal(typeof result.content[0]?.text, 'string');
    assert.match(result.content[0]!.text, /example\.txt/);
    assert.equal(typeof result.details, 'object');
    assert.match(JSON.stringify(result.details), /example\.txt/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('native Octocode tool wrapper preserves responseCharLength pagination in text output', async () => {
  const { tools } = await captureExtensions();
  const tmp = fs.mkdtempSync(
    path.join(packageRoot, '.octocode-pi-local-tool-')
  );
  try {
    fs.writeFileSync(path.join(tmp, 'alpha.txt'), 'alpha', 'utf8');
    fs.writeFileSync(path.join(tmp, 'beta.txt'), 'beta', 'utf8');
    fs.writeFileSync(path.join(tmp, 'gamma.txt'), 'gamma', 'utf8');

    const result = await invokeExecute(
      tools.get('localViewStructure')!,
      { queries: [{ path: tmp, filesOnly: true }], responseCharLength: 80 },
      { cwd: packageRoot }
    );

    assert.match(result.content[0]!.text, /^# Response page 1\//);
    assert.ok(
      result.content[0]!.text.length < JSON.stringify(result.details).length
    );
    assert.equal(
      (result.details as { responsePagination?: { hasMore?: boolean } })
        ?.responsePagination?.hasMore,
      true
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('native Octocode tool wrapper throws so Pi marks execution failed', async () => {
  const { tools } = await captureExtensions();
  await assert.rejects(
    () =>
      invokeExecute(
        tools.get('localViewStructure')!,
        { queries: [{}] },
        { cwd: packageRoot }
      ),
    /path|expected string/
  );
});

// ─── spawnAgent / AgentMessage: real parallel process orchestration ─────────

interface MockAgentProcess {
  stdinWrites: string[];
  killSignals: Array<NodeJS.Signals | undefined>;
  stdin: { write(data: string): void; end(): void };
  stdout: { on(event: string, cb: (chunk: Buffer | string) => void): void };
  stderr: { on(event: string, cb: (chunk: Buffer | string) => void): void };
  on(event: string, cb: (...args: unknown[]) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
  killed?: boolean;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  emitStdout(line: unknown): void;
  emitStderr(text: string): void;
  close(code?: number, signal?: string): void;
}

function createMockAgentProcess(): MockAgentProcess {
  const stdoutHandlers: Array<(chunk: Buffer | string) => void> = [];
  const stderrHandlers: Array<(chunk: Buffer | string) => void> = [];
  const closeHandlers: Array<(...args: unknown[]) => void> = [];
  const errorHandlers: Array<(...args: unknown[]) => void> = [];
  const proc: MockAgentProcess = {
    stdinWrites: [],
    killSignals: [],
    stdin: {
      write(data: string) {
        proc.stdinWrites.push(data);
      },
      end() {
        /* no-op */
      },
    },
    stdout: {
      on(event, cb) {
        if (event === 'data') stdoutHandlers.push(cb);
      },
    },
    stderr: {
      on(event, cb) {
        if (event === 'data') stderrHandlers.push(cb);
      },
    },
    on(event, cb) {
      if (event === 'close') closeHandlers.push(cb);
      if (event === 'error') errorHandlers.push(cb);
    },
    kill(signal?: NodeJS.Signals) {
      proc.killSignals.push(signal);
      proc.killed = true;
      return true;
    },
    emitStdout(line: unknown) {
      stdoutHandlers.forEach(cb => cb(`${JSON.stringify(line)}\n`));
    },
    emitStderr(text: string) {
      stderrHandlers.forEach(cb => cb(text));
    },
    close(code = 0, signal?: string) {
      proc.exitCode = code;
      proc.signalCode = (signal as NodeJS.Signals | undefined) ?? null;
      closeHandlers.forEach(cb => cb(code, signal));
    },
  };
  void errorHandlers;
  return proc;
}

test('normalizeWorkerOutput extracts typed worker handbacks', () => {
  const normalized = normalizeWorkerOutput([
    '[STATUS] scanning repo',
    '[EVIDENCE] packages/foo.ts:12 proves the claim',
    '[FINDING] found the issue',
    '[VERIFICATION] yarn test passed',
    '[CONFIDENCE] likely',
    '[NEXT] parent should inspect the linked file',
    '[DONE] ready for parent verification',
  ].join('\n'));

  assert.equal(normalized.status, 'done');
  assert.equal(normalized.result, 'found the issue');
  assert.deepEqual(normalized.evidence, ['packages/foo.ts:12 proves the claim']);
  assert.equal(normalized.verification, 'yarn test passed');
  assert.equal(normalized.confidence, 'likely');
  assert.equal(normalized.next, 'parent should inspect the linked file');
  assert.deepEqual(normalized.rawPrefixes.STATUS, ['scanning repo']);
});

test('normalizeWorkerOutput accepts role-specific verification and result prefixes', () => {
  const normalized = normalizeWorkerOutput([
    '[ROOT] cache key ignored provider',
    '[VERIFY] yarn workspace @octocodeai/pi-extension test passed',
    '[DONE] root cause isolated',
  ].join('\n'));

  assert.equal(normalized.status, 'done');
  assert.equal(normalized.result, 'cache key ignored provider');
  assert.equal(normalized.verification, 'yarn workspace @octocodeai/pi-extension test passed');
  assert.equal(normalized.next, 'root cause isolated');
});

test('normalizeWorkerOutput falls back safely for unstructured output', () => {
  const normalized = normalizeWorkerOutput('plain worker response');

  assert.equal(normalized.status, 'unknown');
  assert.equal(normalized.confidence, 'uncertain');
  assert.deepEqual(normalized.evidence, []);
  assert.equal(normalized.result, 'plain worker response');
});

test('evaluateWorkerRecoveryRisk warns on long evidence-free repair loops', () => {
  const risk = evaluateWorkerRecoveryRisk([
    '[STATUS] repairing the parser',
    '[ACTION] retry the same parser fix',
    '[STATUS] repairing the parser',
    '[ACTION] retry the same parser fix',
  ].join('\n'));

  assert.ok(risk.warnings.some((warning) => /recovery loop/i.test(warning)));
  assert.ok(risk.warnings.some((warning) => /evidence/i.test(warning)));
});

test('evaluateWorkerRecoveryRisk stays quiet when recovery has evidence and verification', () => {
  const risk = evaluateWorkerRecoveryRisk([
    '[STATUS] reproducing failure',
    '[EVIDENCE] tests/parser.test.ts:42 fails before fix',
    '[ACTION] patch parser guard',
    '[VERIFICATION] yarn workspace @octocodeai/pi-extension test passed',
    '[DONE] ready',
  ].join('\n'));

  assert.deepEqual(risk.warnings, []);
});

test('runHookMiddleware preserves order, merges results, and stops tool_call on block', async () => {
  const calls: string[] = [];
  const blocked = await runHookMiddleware('tool_call', [
    { name: 'first', handler: async () => { calls.push('first'); return { reason: 'warn' }; } },
    { name: 'blocker', handler: async () => { calls.push('blocker'); return { block: true, reason: 'blocked' }; } },
    { name: 'after', handler: async () => { calls.push('after'); return { reason: 'late' }; } },
  ], [{ toolName: 'write' }, {}]);

  assert.deepEqual(calls, ['first', 'blocker']);
  assert.deepEqual(blocked, { reason: 'blocked', block: true });

  const nonBlocking = await runHookMiddleware('session_start', [
    { name: 'a', handler: async () => ({ a: 1 }) },
    { name: 'b', handler: async () => ({ b: 2 }) },
  ], [{}, {}]);
  assert.deepEqual(nonBlocking, { a: 1, b: 2 });
});

test('runHookMiddleware blocks tool_call when middleware throws', async () => {
  const errors: string[] = [];
  const result = await runHookMiddleware('tool_call', [
    { name: 'gate', handler: async () => { throw new Error('boom'); } },
    { name: 'after', handler: async () => ({ reason: 'late' }) },
  ], [{ toolName: 'write' }, {}], {
    onError: (error, event, middleware) => errors.push(`${event}/${middleware}:${(error as Error).message}`),
  });

  assert.deepEqual(errors, ['tool_call/gate:boom']);
  assert.deepEqual(result, {
    block: true,
    reason: 'Octocode hook tool_call/gate failed: boom',
  });
});

test('AgentMessage status surfaces recovery-risk warnings for looping workers', async () => {
  const spawned: Array<{ proc: MockAgentProcess }> = [];
  setAgentProcessFactoryForTests(() => {
    const proc = createMockAgentProcess();
    spawned.push({ proc });
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;
    const result = await invokeExecute(spawnTool, { task: 'repair parser', name: 'repair-loop' });
    const agentId = (result.details as { agent: { agentId: string } }).agent.agentId;

    spawned[0]!.proc.emitStdout({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '[STATUS] repairing parser\n[ACTION] retry parser fix\n[STATUS] repairing parser\n[ACTION] retry parser fix',
        }],
      },
    });

    const list = await invokeExecute(messageTool, { action: 'list' });
    const listText = list.content[0]!.text;
    assert.match(listText, /⚠ recovery/);

    const status = await invokeExecute(messageTool, { action: 'status', agentId });
    const text = status.content[0]!.text;
    const summary = (status.details as { agent: { recoveryRisk?: { warnings: string[] } } }).agent;
    assert.match(text, /recovery-risk:/);
    assert.ok(summary.recoveryRisk?.warnings.some((warning) => /recovery loop/i.test(warning)));
  } finally {
    cleanupSpawnedAgentsForShutdown();
    setAgentProcessFactoryForTests(null);
  }
});

test('evaluateSpawnPolicy warns about packet gaps, provider guidance, fan-out, and recursive tools', () => {
  const result = evaluateSpawnPolicy({
    task: 'Goal: check docs\nScope: docs only',
    model: 'claude-haiku-4-5-20251001',
    tools: ['web', 'spawnAgent'],
  }, 6);

  assert.equal(result.allowed, true);
  assert.ok(result.warnings.some((warning) => /fan-out/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /ownership/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /provider/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /Recursive worker tool/i.test(warning)));

  const scoped = evaluateSpawnPolicy({
    task: 'Goal: check docs\nScope: docs only\nOwnership: read-only\nAcceptance: summary\nReturn: packet',
    model: 'zai-org/GLM-5.2',
  });
  assert.ok(scoped.warnings.some((warning) => /provider/i.test(warning)));

  const withProvider = evaluateSpawnPolicy({
    task: 'Goal: check docs\nScope: docs only\nOwnership: read-only\nAcceptance: summary\nReturn: packet',
    model: 'zai-org/GLM-5.2',
    provider: 'nebius',
  });
  assert.ok(!withProvider.warnings.some((warning) => /provider/i.test(warning)));

  const blocked = evaluateSpawnPolicy({ task: 'Goal: overflow' }, 50);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? '', /capacity/);
});

test('evaluateSpawnPolicy honors OCTOCODE_AGENT_MAX_ACTIVE and warning env overrides', () => {
  const previousMax = process.env['OCTOCODE_AGENT_MAX_ACTIVE'];
  const previousWarn = process.env['OCTOCODE_AGENT_WARNING_ACTIVE'];
  process.env['OCTOCODE_AGENT_MAX_ACTIVE'] = '2';
  process.env['OCTOCODE_AGENT_WARNING_ACTIVE'] = '1';
  try {
    const warned = evaluateSpawnPolicy({ task: 'Goal: docs\nScope: docs\nOwnership: read-only\nAcceptance: summary\nReturn: packet' }, 1);
    assert.equal(warned.allowed, true);
    assert.ok(warned.warnings.some((warning) => /1\/2 active agents/i.test(warning)));

    const blocked = evaluateSpawnPolicy({ task: 'Goal: docs' }, 2);
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason ?? '', /2\/2 active agents/);
  } finally {
    if (previousMax === undefined) delete process.env['OCTOCODE_AGENT_MAX_ACTIVE'];
    else process.env['OCTOCODE_AGENT_MAX_ACTIVE'] = previousMax;
    if (previousWarn === undefined) delete process.env['OCTOCODE_AGENT_WARNING_ACTIVE'];
    else process.env['OCTOCODE_AGENT_WARNING_ACTIVE'] = previousWarn;
  }
});

test('spawnAgent starts a lean RPC Pi process and AgentMessage can list/status/send', async () => {
  const spawned: Array<{
    command: string;
    args: string[];
    options: { cwd?: string };
    proc: MockAgentProcess;
  }> = [];
  setAgentProcessFactoryForTests((command, args, options) => {
    const proc = createMockAgentProcess();
    spawned.push({ command, args, options, proc });
    return proc;
  });
  try {
    const { tools, commands } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;
    const agentsCommand = commands.get('octocode-agents')!;
    assert.ok(spawnTool, 'spawnAgent registered');
    assert.ok(messageTool, 'AgentMessage registered');
    assert.ok(agentsCommand, 'octocode-agents command registered');
    assert.match(agentsCommand.description, /inspect <id>/);
    const inspectCompletion = agentsCommand.getArgumentCompletions?.('i')?.find(item => item.value === 'inspect ');
    assert.ok(
      inspectCompletion,
      'octocode-agents completions include inspect from the centralized command contract'
    );
    assert.match(inspectCompletion.description ?? '', /full state/);
    assert.ok(
      agentsCommand.getArgumentCompletions?.('h')?.some(item => item.value === 'help'),
      'octocode-agents completions include help'
    );
    assert.match(
      spawnTool.promptGuidelines?.join('\n') ?? '',
      /delegation materially helps/
    );
    assert.match(
      spawnTool.promptGuidelines?.join('\n') ?? '',
      /current Pi process/
    );
    assert.match(
      spawnTool.promptGuidelines?.join('\n') ?? '',
      /pi -ne --list-models/
    );
    assert.match(
      spawnTool.promptGuidelines?.join('\n') ?? '',
      /hardcoded config paths/
    );
    assert.match(
      String(
        (
          spawnTool.parameters.properties as Record<
            string,
            { description?: string }
          >
        ).model?.description ?? ''
      ),
      /pi -ne --list-models/
    );
    assert.match(
      messageTool.promptGuidelines?.join('\n') ?? '',
      /synthesize findings instead of dumping raw worker JSON/
    );
    assert.match(messageTool.promptGuidelines?.join('\n') ?? '', /in-memory/);
    assert.equal(
      tools.has('handoff_context'),
      false,
      'legacy handoff_context removed'
    );

    const result = await invokeExecute(
      spawnTool,
      {
        task: 'check the docs',
        context: 'Relevant file: docs/a.md',
        name: 'docs-scout',
        model: 'sonnet:high',
        tools: ['read', 'grep'],
      },
      { cwd: '/repo' }
    );
    const collapsedSpawn = spawnTool.renderResult!(result, {
      expanded: false,
    }).render(120)[0]!;
    assert.match(collapsedSpawn, /spawnAgent · docs-scout · spawned/);
    assert.match(collapsedSpawn, /use AgentMessage wait\/status/);
    assert.doesNotMatch(collapsedSpawn, /expand for output/);
    assert.doesNotMatch(collapsedSpawn, /running/);

    assert.equal(spawned.length, 1);
    assert.ok(spawned[0]!.args.includes('--mode'));
    assert.ok(spawned[0]!.args.includes('rpc'));
    assert.ok(spawned[0]!.args.includes('--no-extensions'));
    assert.ok(spawned[0]!.args.includes('--no-skills'));
    assert.equal(
      spawned[0]!.args.includes('--skill'),
      false,
      'clean spawnAgent has no skills unless provided'
    );
    assert.ok(spawned[0]!.args.includes('--model'));
    assert.ok(spawned[0]!.args.includes('sonnet:high'));
    assert.ok(spawned[0]!.args.includes('--exclude-tools'));
    assert.ok(spawned[0]!.args.includes('spawnAgent,AgentMessage,spawnSubagent'));
    assert.ok(spawned[0]!.args.includes('--tools'));
    assert.ok(spawned[0]!.args.includes('read,grep'));
    assert.equal(spawned[0]!.options.cwd, '/repo');
    assert.match(
      spawned[0]!.proc.stdinWrites[0]!,
      /Context for this delegated agent/
    );
    assert.match(spawned[0]!.proc.stdinWrites[0]!, /check the docs/);

    const agentId = (result.details as { agent: { agentId: string } }).agent
      .agentId;
    const list = await invokeExecute(messageTool, { action: 'list' });
    // list content shows shortId (first 8 chars) for readability; full agentId is in details
    assert.match(list.content[0]!.text, new RegExp(agentId.slice(0, 8)));
    spawned[0]!.proc.emitStdout({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '[STATUS] checking docs\n[RESULT] docs are current\n[EVIDENCE] docs/a.md:1\n[VERIFICATION] inspected docs/a.md\n[CONFIDENCE] confirmed\n[NEXT] parent can synthesize\n[DONE] ready for synthesis',
        }],
      },
    });
    spawned[0]!.proc.emitStdout({ type: 'agent_end', messages: [] });
    const waitStatuses: Array<[string, string | undefined]> = [];
    const waitResult = await invokeExecute(
      messageTool,
      {
        action: 'wait',
        agentId,
        timeoutMs: 1000,
      },
      {
        hasUI: true,
        ui: {
          setStatus: (key: string, value: string | undefined) =>
            waitStatuses.push([key, value]),
        },
      }
    );
    const waitText = waitResult.content[0]!.text;
    const waitAgent = (waitResult.details as { agent: { normalizedResult?: { status: string; result?: string; evidence: string[]; verification?: string; confidence: string; next?: string }; ledgerEvents?: Array<{ type: string; message?: string }>; policyWarnings?: string[] } }).agent;
    assert.equal(waitAgent.normalizedResult?.status, 'done');
    assert.equal(waitAgent.normalizedResult?.result, 'docs are current');
    assert.deepEqual(waitAgent.normalizedResult?.evidence, ['docs/a.md:1']);
    assert.equal(waitAgent.normalizedResult?.verification, 'inspected docs/a.md');
    assert.equal(waitAgent.normalizedResult?.confidence, 'confirmed');
    assert.equal(waitAgent.normalizedResult?.next, 'parent can synthesize');
    assert.match(waitText, /result: docs are current/);
    assert.match(waitText, /verification: inspected docs\/a\.md/);
    assert.ok(waitAgent.ledgerEvents?.some(event => event.type === 'spawned'));
    assert.ok(waitAgent.ledgerEvents?.some(event => event.type === 'handback'));
    assert.deepEqual(
      waitStatuses.filter(([key]) => key === 'agent-wait'),
      [
        ['agent-wait', '⧗ Waiting for “docs-scout”…'],
        ['agent-wait', undefined],
      ]
    );
    assert.ok(waitAgent.policyWarnings?.some(warning => /missing recommended section/i.test(warning)));
    const ledgerEntries = listWorkerLedgerEntries();
    assert.ok(ledgerEntries.some(entry =>
      entry.agentId === agentId
      && entry.normalizedStatus === 'done'
      && entry.result === 'docs are current'
      && entry.verification === 'inspected docs/a.md'
    ));

    type TestTheme = { fg(color: string, text: string): string; bold(text: string): string };
    type TestWidgetContent = string[] | ((tui: unknown, theme: TestTheme) => { render(width: number): string[] });
    const widgetCalls: Array<{
      name: string;
      content: TestWidgetContent | undefined;
      opts?: { placement?: 'aboveEditor' | 'belowEditor' };
    }> = [];
    const notifications: Array<{ message: string; level?: string }> = [];
    const agentCommandCtx = () => ({
      hasUI: true,
      ui: {
        notify: (message: string, level?: string) => notifications.push({ message, level }),
        setStatus: () => undefined,
        setWidget: (name: string, content: TestWidgetContent | undefined, opts?: { placement?: 'aboveEditor' | 'belowEditor' }) =>
          widgetCalls.push({ name, content, opts }),
      },
    });
    await agentsCommand.handler('help', agentCommandCtx());
    assert.match(notifications.at(-1)?.message ?? '', /inspect <id-or-prefix>/);
    assert.match(notifications.at(-1)?.message ?? '', /ids can be full ids or short prefixes/);

    await agentsCommand.handler('', agentCommandCtx());
    assert.match(notifications.at(-1)?.message ?? '', /docs-scout/);
    assert.match(notifications.at(-1)?.message ?? '', /done/);
    const widgetCall = widgetCalls.find(call => call.name === 'octocode-agents' && typeof call.content === 'function');
    assert.equal(widgetCall?.opts?.placement, 'belowEditor');
    const widget = (widgetCall?.content as (tui: unknown, theme: TestTheme) => { render(width: number): string[] })(null, {
      fg: (color: string, text: string) => `<${color}:${text}>`,
      bold: (text: string) => `*${text}*`,
    });
    const widgetLines = widget.render(160);
    assert.match(widgetLines[0] ?? '', /<toolTitle:Octocode agents>/);
    assert.ok(
      widgetLines.some(line => /<success:✓>/.test(line) && /<accent:docs-scout>/.test(line)),
      'agent ledger widget uses theme-aware status and name coloring'
    );

    await agentsCommand.handler(`inspect ${agentId.slice(0, 8)}`, agentCommandCtx());
    assert.match(notifications.at(-1)?.message ?? '', /Agent status \[docs-scout\]/);
    assert.match(notifications.at(-1)?.message ?? '', /evidence: docs\/a\.md:1/);

    await agentsCommand.handler('prune', agentCommandCtx());
    assert.match(notifications.at(-1)?.message ?? '', /Pruned 0 Octocode agent/);
    await invokeExecute(messageTool, {
      action: 'send',
      agentId,
      message: 'also inspect tests',
    });
    const idleSend = JSON.parse(spawned[0]!.proc.stdinWrites.at(-1)!);
    assert.equal(idleSend.type, 'prompt');
    assert.equal(idleSend.message, 'also inspect tests');
    assert.equal(
      'streamingBehavior' in idleSend,
      false,
      'idle send must not force followUp'
    );

    await invokeExecute(messageTool, {
      action: 'send',
      agentId,
      message: 'queue after current turn',
    });
    const runningSend = JSON.parse(spawned[0]!.proc.stdinWrites.at(-1)!);
    assert.equal(
      runningSend.streamingBehavior,
      'followUp',
      'running send defaults to followUp'
    );
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('spawnAgent gives each worker a distinct Awareness identity', async () => {
  const spawned: Array<{
    options: { env?: NodeJS.ProcessEnv };
    proc: MockAgentProcess;
  }> = [];
  setAgentProcessFactoryForTests((_command, _args, options) => {
    const proc = createMockAgentProcess();
    spawned.push({ options, proc });
    return proc;
  });
  try {
    await withAgentId('parent-agent', async () => {
      const { tools } = await captureExtensions();
      const spawnTool = tools.get('spawnAgent')!;

      await invokeExecute(spawnTool, { task: 'first bounded task' });
      await invokeExecute(spawnTool, { task: 'second bounded task' });

      const workerIds = spawned.map(
        item => item.options.env?.['OCTOCODE_AGENT_ID']
      );
      assert.equal(spawned.length, 2);
      assert.ok(
        workerIds.every(id => id?.startsWith('parent-agent:worker:')),
        'worker identities preserve the parent prefix'
      );
      assert.notEqual(workerIds[0], 'parent-agent');
      assert.notEqual(workerIds[0], workerIds[1]);
      assert.ok(
        spawned.every(
          item => item.options.env?.['OCTOCODE_PI_SUBAGENT'] === '1'
        )
      );
      assert.equal(process.env['OCTOCODE_AGENT_ID'], 'parent-agent');
    });
  } finally {
    cleanupSpawnedAgentsForShutdown();
    setAgentProcessFactoryForTests(null);
  }
});

test('spawnAgent covers octocode resource options, prompt file cleanup, list renderers, and dead-worker messaging', async () => {
  const spawned: Array<{
    command: string;
    args: string[];
    options: { cwd?: string };
    proc: MockAgentProcess;
  }> = [];
  setAgentProcessFactoryForTests((command, args, options) => {
    const proc = createMockAgentProcess();
    spawned.push({ command, args, options, proc });
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;
    const theme = {
      bold: (text: string) => `<b>${text}</b>`,
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    };

    const result = await invokeExecute(
      spawnTool,
      {
        prompt: 'run with every option',
        name: 'strange worker name!*',
        provider: 'openai',
        model: 'gpt-test',
        thinking: 'low',
        tools: ['spawnAgent', 'AgentMessage', 'web'],
        systemPrompt: 'extra worker rules',
        resourceMode: 'octocode',
        noSession: false,
        skills: ['/repo/.agents/skills/octocode-research'],
      },
      { cwd: '/repo' }
    );

    const args = spawned[0]!.args;
    assert.ok(
      args.includes('-e'),
      'octocode resource mode loads this extension explicitly'
    );
    assert.ok(args.includes('--provider'));
    assert.ok(args.includes('openai'));
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('gpt-test'));
    assert.ok(args.includes('--thinking'));
    assert.ok(args.includes('low'));
    assert.ok(args.includes('--skill'));
    assert.ok(args.includes('/repo/.agents/skills/octocode-research'));
    assert.ok(args.includes('--tools'));
    assert.ok(
      args.includes('web'),
      'forbidden recursive tools are filtered from worker --tools'
    );
    assert.equal(
      args.includes('--no-session'),
      false,
      'noSession:false omits --no-session'
    );

    const promptPath = args[args.indexOf('--append-system-prompt') + 1]!;
    assert.equal(
      fs.existsSync(promptPath),
      true,
      'system prompt file is created for worker'
    );
    assert.match(path.basename(promptPath), /^strange_worker_name/);

    const spawnExpanded = spawnTool.renderResult!(
      result,
      { expanded: true },
      theme
    ).render(160);
    assert.ok(
      spawnExpanded.some(line =>
        line.includes('<toolTitle>spawnAgent</toolTitle>')
      )
    );

    const agentId = (result.details as { agent: { agentId: string } }).agent
      .agentId;
    const list = await invokeExecute(messageTool, { action: 'list' });
    assert.match(
      messageTool.renderCall!({ action: 'list' }, theme).render(120)[0]!,
      /<accent>list<\/accent>.*all/
    );
    assert.match(
      messageTool.renderCall!(
        { action: 'steer', agentId, message: 'x'.repeat(80) },
        theme
      ).render(120)[0]!,
      /strange worker name/
    );
    assert.match(
      messageTool.renderResult!(list, { expanded: false }, theme).render(
        120
      )[0]!,
      /1 total · 1 running/
    );
    assert.ok(
      messageTool.renderResult!(list, { expanded: true }, theme).render(160)
        .length > 1
    );
    assert.equal(
      messageTool.renderResult!(list, { isPartial: true }, theme).render(
        120
      )[0],
      '<warning>⧗ Agent working…</warning>'
    );

    const noOutputStatus = await invokeExecute(messageTool, {
      action: 'status',
      agentId,
    });
    const noOutputCollapsed = messageTool.renderResult!(
      noOutputStatus,
      { expanded: false },
      theme
    ).render(240)[0]!;
    assert.match(noOutputCollapsed, /no output yet/);
    assert.doesNotMatch(noOutputCollapsed, /expand for output/);

    spawned[0]!.proc.emitStdout({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'worker says hello\nsecond line' }],
      },
    });
    const outputStatus = await invokeExecute(messageTool, {
      action: 'status',
      agentId,
    });
    const outputCollapsed = messageTool.renderResult!(
      outputStatus,
      { expanded: false },
      theme
    ).render(240)[0]!;
    assert.match(outputCollapsed, /worker says hello/);
    assert.doesNotMatch(outputCollapsed, /expand for output/);

    spawned[0]!.proc.close(0);
    assert.equal(
      fs.existsSync(path.dirname(promptPath)),
      false,
      'prompt temp directory is removed after process close'
    );
    await assert.rejects(
      () =>
        invokeExecute(messageTool, {
          action: 'followUp',
          agentId,
          message: 'too late',
        }),
      /cannot reach agent/
    );

    const failedRendered = messageTool.renderResult!(
      {
        isError: true,
        content: [{ type: 'text', text: 'bad' }],
        details: { agent: { name: 'failed-one', status: 'failed' } },
      },
      { expanded: true },
      theme
    ).render(120);
    assert.match(failedRendered[0]!, /failed-one/);
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('spawnSubagent starts the browser-agent with the typed prompt, tools, all Octocode skills, and octocode resource mode', async () => {
  const spawned: Array<{
    command: string;
    args: string[];
    options: { cwd?: string };
    proc: MockAgentProcess;
  }> = [];
  setAgentProcessFactoryForTests((command, args, options) => {
    const proc = createMockAgentProcess();
    spawned.push({ command, args, options, proc });
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnSubagent = tools.get('spawnSubagent')!;
    assert.ok(spawnSubagent, 'spawnSubagent registered');

    const result = await invokeExecute(
      spawnSubagent,
      {
        agent: 'browser-agent',
        task: 'audit cookie flags and service workers',
        url: 'https://example.com/app',
        port: 19333,
        launch: true,
        headless: false,
        cwd: '/repo',
      },
      { cwd: '/fallback' }
    );

    assert.equal(spawned.length, 1);
    const args = spawned[0]!.args;
    assert.equal(spawned[0]!.options.cwd, '/repo');
    assert.ok(args.includes('--no-extensions'));
    assert.ok(
      args.includes('-e'),
      'browser subagent should load this extension explicitly'
    );
    assert.ok(
      args.includes('--skill'),
      'browser subagent should load its browser-agent skill'
    );
    const skillArgs = argValues(args, '--skill');
    assertHasAllOctocodeSkills(skillArgs);
    assert.ok(
      skillArgs.some(skillPath =>
        skillPath.endsWith(
          path.join('subagents', 'browser-agent', 'skills', 'browser-agent')
        )
      ),
      'browser subagent should load its browser-agent skill'
    );
    assert.ok(args.includes('--tools'));
    assert.ok(
      args.includes(
        'chromeDebug,web,localGetFileContent,localSearchCode,localViewStructure'
      )
    );
    assert.ok(args.includes('--thinking'));
    assert.ok(args.includes('low'));
    assert.ok(
      args.includes('--append-system-prompt'),
      'typed subagent loads its SYSTEM_PROMPT.md'
    );

    const initialPrompt = spawned[0]!.proc.stdinWrites[0]!;
    assert.match(initialPrompt, /Browser Session/);
    assert.match(initialPrompt, /Target URL: https:\/\/example\.com\/app/);
    assert.match(initialPrompt, /Chrome port: 19333/);
    assert.match(initialPrompt, /Launch Chrome: true/);
    assert.match(initialPrompt, /Headless: false/);
    assert.match(initialPrompt, /audit cookie flags and service workers/);

    assert.match(result.content[0]!.text, /\[SPAWNED\] Browser Agent/);
    assert.match(result.content[0]!.text, /skills: [^\n]*browser-agent/);
    assert.match(result.content[0]!.text, /resourceMode: octocode/);
    const collapsed = spawnSubagent.renderResult!(result, {
      expanded: false,
    }).render(120)[0]!;
    assert.match(collapsed, /Browser Agent/);
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('spawnSubagent starts researcher, planner, and architect with all Octocode skills', async () => {
  const spawned: Array<{
    args: string[];
    options: { cwd?: string };
    proc: MockAgentProcess;
  }> = [];
  setAgentProcessFactoryForTests((_command, args, options) => {
    const proc = createMockAgentProcess();
    spawned.push({ args, options, proc });
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnSubagent = tools.get('spawnSubagent')!;
    const schema = spawnSubagent.parameters as {
      properties?: { agent?: { enum?: string[] } };
    };
    assert.deepEqual(schema.properties?.agent?.enum, [
      'browser-agent',
      'researcher',
      'planner',
      'architect',
    ]);
    assert.match(
      spawnSubagent.promptGuidelines!.join('\n'),
      /pi -ne --list-models/
    );
    assert.match(
      spawnSubagent.promptGuidelines!.join('\n'),
      /hardcoded config paths/
    );
    assert.match(
      String(
        (
          spawnSubagent.parameters.properties as Record<
            string,
            { description?: string }
          >
        ).model?.description ?? ''
      ),
      /pi -ne --list-models/
    );

    for (const agent of ['researcher', 'planner', 'architect']) {
      const result = await invokeExecute(
        spawnSubagent,
        {
          agent,
          task: `phase one for ${agent}`,
          ...(agent === 'planner' ? { model: 'sonnet:high' } : {}),
          cwd: '/repo',
        },
        { cwd: '/fallback' }
      );
      assert.match(
        result.content[0]!.text,
        new RegExp(
          `\\[SPAWNED\\] .*${agent === 'researcher' ? 'Researcher' : agent === 'planner' ? 'Planner' : 'Architect'}`
        )
      );
    }

    assert.equal(spawned.length, 3);
    const [researcherArgs, plannerArgs, architectArgs] = spawned.map(
      item => item.args
    );
    for (const args of [researcherArgs!, plannerArgs!, architectArgs!]) {
      assert.ok(args.includes('--no-extensions'));
      assert.ok(
        args.includes('-e'),
        'typed subagents should load this extension explicitly'
      );
      assert.ok(
        args.includes('--no-skills'),
        'typed subagents use explicit skill paths with --no-skills'
      );
      assertHasAllOctocodeSkills(argValues(args, '--skill'));
      assert.equal(
        argValues(args, '--skill').some(skillPath =>
          skillPath.includes(
            `${path.sep}subagents${path.sep}browser-agent${path.sep}`
          )
        ),
        false,
        'non-browser specialists should not load the browser-agent skill'
      );
      assert.ok(
        args.includes('--append-system-prompt'),
        'typed subagents load their SYSTEM_PROMPT.md'
      );
      assert.ok(args.includes('--tools'));
    }

    const researcherTools =
      researcherArgs![researcherArgs!.indexOf('--tools') + 1]!;
    assert.match(researcherTools, /ghSearchCode/);
    assert.match(researcherTools, /npmSearch/);
    assert.match(researcherTools, /lspGetSemantics/);
    assert.doesNotMatch(researcherTools, /bash/);

    const plannerTools = plannerArgs![plannerArgs!.indexOf('--tools') + 1]!;
    assert.match(plannerTools, /ghHistoryResearch/);
    assert.match(plannerTools, /localGetFileContent/);
    assert.doesNotMatch(plannerTools, /bash/);
    assert.ok(plannerArgs!.includes('--model'));
    assert.ok(plannerArgs!.includes('sonnet:high'));

    const architectTools =
      architectArgs![architectArgs!.indexOf('--tools') + 1]!;
    assert.match(architectTools, /bash/);
    assert.match(architectTools, /localBinaryInspect/);
    assert.match(architectTools, /lspGetSemantics/);
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('spawnSubagent covers context injection, invalid URL name fallback, unknown agent, and render fallback', async () => {
  const spawned: Array<{ args: string[]; proc: MockAgentProcess }> = [];
  setAgentProcessFactoryForTests((_command, args, _options) => {
    const proc = createMockAgentProcess();
    spawned.push({ args, proc });
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnSubagent = tools.get('spawnSubagent')!;

    const result = await invokeExecute(
      spawnSubagent,
      {
        agent: 'browser-agent',
        task: 'inspect current page',
        context: 'Prior finding: auth cookie missing Secure',
        url: 'not a valid url',
      },
      { cwd: '/repo' }
    );
    const initialPrompt = JSON.parse(spawned[0]!.proc.stdinWrites[0]!) as {
      message: string;
    };
    assert.match(initialPrompt.message, /## Context\nPrior finding/);
    assert.match(
      result.content[0]!.text,
      /\[SPAWNED\] Browser Agent · agentId:/
    );
    assert.match(result.content[0]!.text, /\[SPAWNED\] name: Browser Agent · /);

    await assert.rejects(
      () =>
        invokeExecute(spawnSubagent, { agent: 'missing-agent', task: 'nope' }),
      /Unknown subagent/
    );
    assert.match(
      spawnSubagent.renderCall!({
        agent: 'missing-agent',
        task: 'x'.repeat(80),
      }).render(120)[0]!,
      /spawnSubagent\(missing-agent\).*…/
    );
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('spawnSubagent remains available for non-browser specialists when Chrome debug is disabled', async () => {
  const previous = process.env['OCTOCODE_CHROME_DEBUG'];
  process.env['OCTOCODE_CHROME_DEBUG'] = '0';
  try {
    const { tools } = await captureExtensions();
    assert.equal(tools.has('chromeDebug'), false);
    assert.equal(tools.has('browserAgent'), false);
    assert.equal(
      tools.has('spawnSubagent'),
      true,
      'non-browser typed subagents should not be Chrome-gated'
    );
    assert.equal(
      tools.has('spawnAgent'),
      true,
      'clean arbitrary workers still use spawnAgent'
    );
    const spawnSubagent = tools.get('spawnSubagent')!;
    const schema = spawnSubagent.parameters as {
      properties?: { agent?: { enum?: string[] } };
    };
    assert.deepEqual(schema.properties?.agent?.enum, [
      'researcher',
      'planner',
      'architect',
    ]);
    assert.match(spawnSubagent.description!, /researcher/);
    assert.match(spawnSubagent.description!, /architect/);
    assert.doesNotMatch(spawnSubagent.description!, /browser-agent/);
    assert.match(
      spawnSubagent.promptGuidelines!.join('\n'),
      /clean arbitrary workers/
    );
    assert.match(
      spawnSubagent.promptGuidelines!.join('\n'),
      /browser-agent is unavailable/
    );
    await assert.rejects(
      () =>
        invokeExecute(spawnSubagent, {
          agent: 'browser-agent',
          task: 'try browser work',
        }),
      /browser-agent is unavailable because OCTOCODE_CHROME_DEBUG=0 disables chromeDebug/
    );
  } finally {
    if (previous === undefined) delete process.env['OCTOCODE_CHROME_DEBUG'];
    else process.env['OCTOCODE_CHROME_DEBUG'] = previous;
  }
});

test('spawnAgent does not register recursively inside spawned workers', async () => {
  const previous = process.env['OCTOCODE_PI_SUBAGENT'];
  process.env['OCTOCODE_PI_SUBAGENT'] = '1';
  try {
    const { tools } = await captureExtensions();
    assert.equal(tools.has('spawnAgent'), false);
    assert.equal(tools.has('AgentMessage'), false);
    assert.equal(
      tools.has('localSearchCode'),
      true,
      'Octocode tools remain available in octocode worker mode'
    );
  } finally {
    if (previous === undefined) delete process.env['OCTOCODE_PI_SUBAGENT'];
    else process.env['OCTOCODE_PI_SUBAGENT'] = previous;
  }
});

test('AgentMessage wait collects worker output and kill terminates stale workers', async () => {
  const spawned: MockAgentProcess[] = [];
  setAgentProcessFactoryForTests((_command, _args, _options) => {
    const proc = createMockAgentProcess();
    spawned.push(proc);
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;

    const first = await invokeExecute(
      spawnTool,
      { task: 'produce output', resourceMode: 'default' },
      { cwd: '/repo' }
    );
    const firstId = (first.details as { agent: { agentId: string } }).agent
      .agentId;
    spawned[0]!.emitStdout({
      type: 'tool_call',
      toolCallId: 'tool-1',
      toolName: 'localSearchCode',
    });
    const runningStatus = await invokeExecute(messageTool, {
      action: 'status',
      agentId: firstId,
    });
    assert.match(
      runningStatus.content[0]!.text,
      /tools: localSearchCode:running/
    );
    assert.equal(
      (runningStatus.details as { agent: { activeTool?: string } }).agent
        .activeTool,
      'localSearchCode'
    );
    spawned[0]!.emitStdout({
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'localSearchCode',
      isError: false,
    });
    spawned[0]!.emitStdout({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'worker result' }],
      },
    });
    spawned[0]!.emitStdout({ type: 'agent_end', messages: [] });
    const waited = await invokeExecute(messageTool, {
      action: 'wait',
      agentId: firstId,
      timeoutMs: 1000,
    });
    assert.equal(
      (waited.details as { agent: { status: string } }).agent.status,
      'idle'
    );
    assert.match(waited.content[0]!.text, /Agent turn completed/);
    assert.doesNotMatch(waited.content[0]!.text, /Agent completed/);
    assert.match(waited.content[0]!.text, /tools: localSearchCode:done/);
    assert.match(waited.content[0]!.text, /worker result/);
    assert.ok(spawned[0]!.stdinWrites[0]!.includes('produce output'));
    assert.equal(spawned[0]!.stdinWrites[0]!.includes('spawnAgent'), false);

    const second = await invokeExecute(
      spawnTool,
      { task: 'hang around' },
      { cwd: '/repo' }
    );
    const secondId = (second.details as { agent: { agentId: string } }).agent
      .agentId;
    const killed = await invokeExecute(messageTool, {
      action: 'kill',
      agentId: secondId,
      remove: true,
    });
    assert.match(killed.content[0]!.text, /killed/);
    assert.equal(spawned[1]!.killed, true);
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('AgentMessage kill escalates to SIGKILL when a worker does not exit after SIGTERM', async () => {
  vi.useFakeTimers();
  const spawned: MockAgentProcess[] = [];
  setAgentProcessFactoryForTests((_command, _args, _options) => {
    const proc = createMockAgentProcess();
    spawned.push(proc);
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;

    const result = await invokeExecute(
      spawnTool,
      { task: 'ignore sigterm', name: 'stubborn-worker' },
      { cwd: '/repo' }
    );
    const agentId = (result.details as { agent: { agentId: string } }).agent
      .agentId;

    await invokeExecute(messageTool, { action: 'kill', agentId });
    assert.deepEqual(spawned[0]!.killSignals, ['SIGTERM']);

    await vi.advanceTimersByTimeAsync(5000);

    assert.deepEqual(spawned[0]!.killSignals, ['SIGTERM', 'SIGKILL']);
  } finally {
    vi.useRealTimers();
    setAgentProcessFactoryForTests(null);
  }
});

test('AgentMessage abort sends Pi RPC abort command without killing the process', async () => {
  const spawned: MockAgentProcess[] = [];
  setAgentProcessFactoryForTests((_command, _args, _options) => {
    const proc = createMockAgentProcess();
    spawned.push(proc);
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;

    // Schema should include 'abort' in the action enum
    const actionSchema = (
      messageTool.parameters as { properties: { action: { enum?: string[] } } }
    ).properties?.action;
    assert.ok(
      Array.isArray(actionSchema?.enum) && actionSchema.enum.includes('abort'),
      'abort must be in AgentMessage action schema'
    );

    const result = await invokeExecute(
      spawnTool,
      { task: 'analyze something', name: 'target' },
      { cwd: '/repo' }
    );
    const agentId = (result.details as { agent: { agentId: string } }).agent
      .agentId;

    // Send abort — process must NOT be killed
    const aborted = await invokeExecute(messageTool, {
      action: 'abort',
      agentId,
    });
    assert.match(aborted.content[0]!.text, /aborted/i);
    assert.equal(
      spawned[0]!.killed,
      undefined,
      'abort must not kill the process'
    );

    // RPC must have sent { type: 'abort' }
    const lastRpc = JSON.parse(spawned[0]!.stdinWrites.at(-1)!);
    assert.equal(
      lastRpc.type,
      'abort',
      'abort action must send Pi RPC type:"abort"'
    );

    // Aborting an already-exited agent is a no-op (no extra RPC sent)
    spawned[0]!.close(0);
    const writesBefore = spawned[0]!.stdinWrites.length;
    await invokeExecute(messageTool, { action: 'abort', agentId });
    assert.equal(
      spawned[0]!.stdinWrites.length,
      writesBefore,
      'abort on exited agent sends no extra RPC'
    );
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('evictStaleAgents removes oldest terminal agents when registry reaches MAX_AGENT_RECORDS', async () => {
  const spawned: MockAgentProcess[] = [];
  setAgentProcessFactoryForTests((_command, _args, _options) => {
    const proc = createMockAgentProcess();
    spawned.push(proc);
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;

    // Spawn 50 agents (MAX_AGENT_RECORDS) and let them all exit
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await invokeExecute(
        spawnTool,
        { task: `task ${i}`, name: `agent-${i}` },
        { cwd: '/repo' }
      );
      ids.push((r.details as { agent: { agentId: string } }).agent.agentId);
    }
    // Let first 40 exit (terminal) — keep last 10 running
    for (let i = 0; i < 40; i++) {
      spawned[i]!.close(0);
    }

    // Spawn one more — should evict the oldest terminal agent (agent-0)
    const overflow = await invokeExecute(
      spawnTool,
      { task: 'overflow', name: 'overflow-agent' },
      { cwd: '/repo' }
    );
    const overflowId = (overflow.details as { agent: { agentId: string } })
      .agent.agentId;

    // List should not include the evicted agent
    const list = await invokeExecute(messageTool, { action: 'list' });
    // overflow-agent must appear in list
    assert.match(list.content[0]!.text, /overflow-agent/);
    // Total agent count in the registry must be ≤ MAX_AGENT_RECORDS (50)
    const agentCount = (list.details as { agents: unknown[] }).agents.length;
    assert.ok(
      agentCount <= 50,
      `Registry must stay ≤ 50 agents, got ${agentCount}`
    );
    // ids[0] (oldest terminal) must be gone
    await assert.rejects(
      () => invokeExecute(messageTool, { action: 'status', agentId: ids[0] }),
      /No agent found/,
      'Oldest evicted agent must not be in the registry'
    );
    void overflowId;
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('waitForAgent timeout error uses agent name, not internal UUID', async () => {
  const spawned: MockAgentProcess[] = [];
  setAgentProcessFactoryForTests((_command, _args, _options) => {
    const proc = createMockAgentProcess();
    spawned.push(proc);
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;

    const result = await invokeExecute(
      spawnTool,
      { task: 'run forever', name: 'my-named-agent' },
      { cwd: '/repo' }
    );
    const agentId = (result.details as { agent: { agentId: string } }).agent
      .agentId;

    // Wait with a tiny timeout — must mention the agent name, not the UUID
    await assert.rejects(
      () =>
        invokeExecute(messageTool, { action: 'wait', agentId, timeoutMs: 1 }),
      (err: Error) => {
        assert.ok(
          err.message.includes('my-named-agent'),
          `Error must include agent name, got: ${err.message}`
        );
        assert.ok(
          !err.message.includes(agentId),
          `Error must NOT expose internal UUID, got: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('getAgent throws actionable error for missing or unknown agentId', async () => {
  setAgentProcessFactoryForTests((_command, _args, _options) =>
    createMockAgentProcess()
  );
  try {
    const { tools } = await captureExtensions();
    const messageTool = tools.get('AgentMessage')!;

    // Missing agentId → clear message directing to action:"list"
    await assert.rejects(
      () => invokeExecute(messageTool, { action: 'status' }),
      (err: Error) => {
        assert.ok(
          err.message.includes('action:"list"'),
          `Must mention action:"list", got: ${err.message}`
        );
        return true;
      }
    );

    // Unknown agentId → mentions how many active agents exist
    await assert.rejects(
      () =>
        invokeExecute(messageTool, {
          action: 'status',
          agentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes('No agent found'),
          `Must say "No agent found", got: ${err.message}`
        );
        assert.ok(
          err.message.includes('action:"list"'),
          `Must mention action:"list", got: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('AgentMessage wait with remove:true cleans up agent from registry after completion', async () => {
  const spawned: MockAgentProcess[] = [];
  setAgentProcessFactoryForTests((_command, _args, _options) => {
    const proc = createMockAgentProcess();
    spawned.push(proc);
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;

    const result = await invokeExecute(
      spawnTool,
      { task: 'do work', name: 'temp-worker' },
      { cwd: '/repo' }
    );
    const agentId = (result.details as { agent: { agentId: string } }).agent
      .agentId;

    // Complete the agent
    spawned[0]!.emitStdout({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });
    spawned[0]!.emitStdout({ type: 'agent_end', messages: [] });

    // Wait with remove:true
    const waited = await invokeExecute(messageTool, {
      action: 'wait',
      agentId,
      timeoutMs: 1000,
      remove: true,
    });
    assert.match(waited.content[0]!.text, /completed/i);

    // Agent must be gone from registry
    await assert.rejects(
      () => invokeExecute(messageTool, { action: 'status', agentId }),
      /No agent found/,
      'Agent must be removed from registry after wait+remove'
    );
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('RPC response with success:false surfaces error in agent result', async () => {
  const spawned: MockAgentProcess[] = [];
  setAgentProcessFactoryForTests((_command, _args, _options) => {
    const proc = createMockAgentProcess();
    spawned.push(proc);
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;

    const result = await invokeExecute(
      spawnTool,
      { task: 'do something', name: 'rpc-test' },
      { cwd: '/repo' }
    );
    const agentId = (result.details as { agent: { agentId: string } }).agent
      .agentId;

    // Simulate Pi sending a failed RPC response (e.g. prompt rejected while streaming)
    spawned[0]!.emitStdout({
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'agent is already streaming — provide streamingBehavior',
    });

    // Status must surface the RPC error
    const status = await invokeExecute(messageTool, {
      action: 'status',
      agentId,
    });
    assert.match(
      status.content[0]!.text,
      /already streaming|streamingBehavior|RPC command failed/,
      'RPC error must appear in agent status output'
    );
    const det = status.details as { agent: { error?: string } };
    assert.ok(det.agent.error, 'error field must be set on the agent record');
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('AgentMessage action schema includes all documented actions', async () => {
  const { tools } = await captureExtensions();
  const messageTool = tools.get('AgentMessage')!;
  const actionSchema = (
    messageTool.parameters as { properties: { action: { enum?: string[] } } }
  ).properties?.action;
  const expectedActions = [
    'list',
    'status',
    'send',
    'steer',
    'followUp',
    'wait',
    'kill',
    'abort',
  ];
  for (const action of expectedActions) {
    assert.ok(
      actionSchema?.enum?.includes(action),
      `AgentMessage action schema must include "${action}"`
    );
  }
});

test('cleanupSpawnedAgentsForShutdown kills only non-terminal spawned workers', async () => {
  const spawned: MockAgentProcess[] = [];
  setAgentProcessFactoryForTests((_command, _args, _options) => {
    const proc = createMockAgentProcess();
    spawned.push(proc);
    return proc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;

    const finished = await invokeExecute(
      spawnTool,
      { task: 'finish', name: 'finished-worker' },
      { cwd: '/repo' }
    );
    const finishedId = (finished.details as { agent: { agentId: string } })
      .agent.agentId;
    spawned[0]!.close(0);

    const running = await invokeExecute(
      spawnTool,
      { task: 'keep running', name: 'running-worker' },
      { cwd: '/repo' }
    );
    const runningId = (running.details as { agent: { agentId: string } }).agent
      .agentId;

    assert.equal(cleanupSpawnedAgentsForShutdown(), 1);
    assert.equal(
      spawned[0]!.killed,
      undefined,
      'terminal worker must not be killed again'
    );
    assert.equal(
      spawned[1]!.killed,
      true,
      'running worker must be killed during shutdown cleanup'
    );

    const finishedStatus = await invokeExecute(messageTool, {
      action: 'status',
      agentId: finishedId,
    });
    assert.match(finishedStatus.content[0]!.text, /status: exited/);
    const runningStatus = await invokeExecute(messageTool, {
      action: 'status',
      agentId: runningId,
    });
    assert.match(runningStatus.content[0]!.text, /status: killed/);
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});

test('AgentMessage send with broken stdin (EPIPE) sets isError:true on result', async () => {
  // When sendRpc throws (e.g. EPIPE because the process already exited but
  // exitCode/signalCode haven't been reaped yet), record.error is set while
  // status stays 'running'. renderSingleAgentResult must flag isError:true so
  // the LLM sees the failure rather than a misleading successful-looking result.
  let brokenProc: MockAgentProcess | undefined;
  setAgentProcessFactoryForTests((_command, _args, _options) => {
    brokenProc = createMockAgentProcess();
    // Allow the first write (initial prompt delivery), then throw EPIPE.
    let callCount = 0;
    const origWrite = brokenProc.stdin.write.bind(brokenProc.stdin);
    brokenProc.stdin.write = (data: string) => {
      callCount++;
      if (callCount > 1) {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      }
      return origWrite(data);
    };
    return brokenProc;
  });
  try {
    const { tools } = await captureExtensions();
    const spawnTool = tools.get('spawnAgent')!;
    const messageTool = tools.get('AgentMessage')!;

    const spawnResult = await invokeExecute(
      spawnTool,
      { task: 'epipe target', name: 'epipe-target' },
      { cwd: '/repo' }
    );
    const agentId = (spawnResult.details as { agent: { agentId: string } }).agent.agentId;

    // Second write (callCount = 2) triggers the EPIPE throw.
    const sendResult = await invokeExecute(
      messageTool,
      { action: 'send', agentId, message: 'hello' }
    );

    assert.equal(
      sendResult.isError,
      true,
      'result must be isError:true when sendRpc catches EPIPE'
    );
    assert.match(
      sendResult.content[0]!.text,
      /EPIPE|write/,
      'error text must surface the EPIPE message'
    );
  } finally {
    setAgentProcessFactoryForTests(null);
  }
});
