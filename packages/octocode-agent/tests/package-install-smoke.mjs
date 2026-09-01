import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(join(tmpdir(), 'octocode-agent-pack-'));
const installRoot = join(sandbox, 'install');
const isolatedHome = join(sandbox, 'home');
const isolatedOctocodeHome = join(isolatedHome, '.octocode');
const packageBuildEnv = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  RUSTUP_HOME:
    process.env.RUSTUP_HOME ?? join(process.env.HOME ?? isolatedHome, '.rustup'),
  CARGO_HOME:
    process.env.CARGO_HOME ?? join(process.env.HOME ?? isolatedHome, '.cargo'),
};

const installedCliEnv = Object.fromEntries(Object.entries({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  ComSpec: process.env.ComSpec,
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
  LANG: process.env.LANG,
  LC_ALL: process.env.LC_ALL,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  XDG_CONFIG_HOME: join(isolatedHome, '.config'),
  XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
  XDG_CACHE_HOME: join(isolatedHome, '.cache'),
  OCTOCODE_HOME: isolatedOctocodeHome,
}).filter((entry) => entry[1] !== undefined));

function run(command, args, options = {}) {
  const label = `${command} ${args.join(' ')}`;
  process.stderr.write(`[pack-smoke] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: options.env ?? packageBuildEnv,
    input: options.input,
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) {
    throw new Error(`${label} failed to start or exceeded its timeout: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error([
      `${label} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

try {
  const packOutput = run('npm', ['pack', packageRoot, '--pack-destination', sandbox]);
  const tarballName = packOutput.trim().split(/\r?\n/u).at(-1);
  if (!tarballName?.endsWith('.tgz')) throw new Error(`npm pack did not report a tarball: ${packOutput}`);
  const tarball = join(sandbox, tarballName);

  run('npm', ['install', '--prefix', installRoot, '--no-audit', '--no-fund', tarball]);
  const installedPackageRoot = join(installRoot, 'node_modules', 'octocode-agent');
  const manifest = JSON.parse(await readFile(join(installedPackageRoot, 'package.json'), 'utf8'));
  for (const name of ['@octocodeai/agent-core', '@octocodeai/octocode-shared']) {
    if (manifest.dependencies?.[name] || manifest.optionalDependencies?.[name] || manifest.peerDependencies?.[name]) {
      throw new Error(`packed manifest exposes unpublished runtime dependency ${name}`);
    }
  }
  for (const declaration of [
    join(installedPackageRoot, 'out', 'api', 'v1.d.ts'),
    join(installedPackageRoot, 'out', 'presentation', 'v1.d.ts'),
  ]) {
    const source = await readFile(declaration, 'utf8');
    for (const forbidden of [
      '@octocodeai/agent-core',
      '@octocodeai/octocode-shared',
      'native-launcher',
      'native-customization',
      'presentation/contracts',
    ]) {
      if (source.includes(forbidden)) {
        throw new Error(`public declaration ${declaration} leaks internal type owner ${forbidden}`);
      }
    }
  }
  run(process.execPath, [
    '--input-type=module',
    '--eval',
    [
      "const api = await import('octocode-agent/api/v1');",
      "const presentation = await import('octocode-agent/presentation/v1');",
      "if (Object.keys(api).length === 0) throw new Error('public API subpath is empty');",
      'void presentation;',
    ].join('\n'),
  ], { cwd: installRoot, env: installedCliEnv });

  const consumerSource = join(installRoot, 'public-api-consumer.mts');
  await writeFile(consumerSource, [
    "import * as api from 'octocode-agent/api/v1';",
    "import * as presentation from 'octocode-agent/presentation/v1';",
    "import type { AgentControlEventByTypeV1, AgentPortableCustomizationV1, AgentPortableCustomizationFactoryV1 } from 'octocode-agent/api/v1';",
    "const portable: AgentPortableCustomizationV1 = { schemaVersion: 1, id: 'packed.portable', entrypoint: { kind: 'module', moduleUrl: 'file:///tmp/packed.mjs', exportName: 'activate', integrity: `sha256-${'a'.repeat(64)}` }, workerContributions: [] };",
    "function consume(event: AgentControlEventByTypeV1): string { switch (event.type) { case 'tool.ended': return event.payload.outcome; default: return event.type; } }",
    "const activate: AgentPortableCustomizationFactoryV1 = async ({ target }) => ({ schemaVersion: 1, id: 'packed.portable', productPolicyOverlay: { mode: 'append', content: target } });",
    'void api;',
    'void presentation;',
    'void portable;',
    'void consume;',
    'void activate;',
    '',
  ].join('\n'));
  const consumerConfig = join(installRoot, 'tsconfig.json');
  await writeFile(consumerConfig, `${JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2022',
      types: [],
    },
    files: ['./public-api-consumer.mts'],
  }, null, 2)}\n`);
  const typescriptCompiler = resolve(
    packageRoot,
    '..',
    '..',
    'node_modules',
    'typescript',
    'bin',
    'tsc',
  );
  run(process.execPath, [
    typescriptCompiler,
    '--project',
    consumerConfig,
  ], { cwd: installRoot, env: installedCliEnv });

  const rustBinaryName = process.platform === 'win32'
    ? 'octocode-agent-core-rust.exe'
    : 'octocode-agent-core-rust';
  const rustBinary = join(
    installedPackageRoot,
    'out',
    'native',
    `${process.platform}-${process.arch}`,
    rustBinaryName,
  );
  if (!(await stat(rustBinary)).isFile()) {
    throw new Error('packed CLI omitted its platform Rust core binary');
  }
  const rustResponse = JSON.parse(run(rustBinary, [
    '--db',
    join(sandbox, 'packaged-core.sqlite3'),
  ], { input: '{}\n' }).trim());
  if (rustResponse.ok !== false || rustResponse.schemaVersion !== 1) {
    throw new Error('packed Rust core did not complete a real JSONL exchange');
  }
  const rustFileSystemBinaryName = process.platform === 'win32'
    ? 'octocode-agent-fs.exe'
    : 'octocode-agent-fs';
  const rustFileSystemBinary = join(
    installedPackageRoot,
    'out',
    'native',
    `${process.platform}-${process.arch}`,
    rustFileSystemBinaryName,
  );
  if (!(await stat(rustFileSystemBinary)).isFile()) {
    throw new Error('packed CLI omitted its platform Rust filesystem binary');
  }
  const rustFileSystemResponse = JSON.parse(run(rustFileSystemBinary, [
    '--workspace',
    installRoot,
  ], {
    input: '{"schemaVersion":1,"id":"health","method":"health","params":{}}\n',
  }).trim());
  if (rustFileSystemResponse.ok !== true || rustFileSystemResponse.result?.status !== 'ok') {
    throw new Error('packed Rust filesystem did not complete a real JSONL exchange');
  }

  const executable = process.platform === 'win32'
    ? join(installRoot, 'node_modules', '.bin', 'octocode-agent.cmd')
    : join(installRoot, 'node_modules', '.bin', 'octocode-agent');
  const help = run(executable, ['--help'], { cwd: installRoot, env: installedCliEnv });
  if (!help.includes('discover [surface]')) throw new Error('packed CLI help omitted discovery');
  const discovery = JSON.parse(run(executable, ['discover', '--json'], {
    cwd: installRoot,
    env: installedCliEnv,
  }));
  if (discovery.schemaVersion !== 1 || !discovery.models || !discovery.mcp || !discovery.skills) {
    throw new Error('packed CLI discovery output did not satisfy the inventory contract');
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    package: `${manifest.name}@${manifest.version}`,
    discoverySchemaVersion: discovery.schemaVersion,
  }) + '\n');
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
