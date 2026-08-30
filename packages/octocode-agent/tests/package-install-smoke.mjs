import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(join(tmpdir(), 'octocode-agent-pack-'));
const installRoot = join(sandbox, 'install');
const isolatedHome = join(sandbox, 'home');
const isolatedOctocodeHome = join(isolatedHome, '.octocode');

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
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: options.env ?? { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with status ${result.status}`,
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
