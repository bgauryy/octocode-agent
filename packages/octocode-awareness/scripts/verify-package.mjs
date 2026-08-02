#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

// The outer verifier invokes yarn pack; its prepack recursively invokes this
// script. The inner pass only needs the build, so stop before packing again.
if (process.env.OCTOCODE_VERIFY_PACKAGE_INNER === '1') process.exit(0);

// Same discovery rule as build.mjs — kept independent (not imported) so this
// verification catches a real build-vs-source mismatch instead of trivially
// agreeing with whatever build.mjs produced.
const RETIRED_PACKAGE_SKILLS = ['octocode-agent-communication', 'octocode-reflection'];
function discoverPackageSkills() {
  const candidateRoots = [join(packageRoot, 'skills'), join(packageRoot, 'out', 'skills')];
  const skillsRoot = candidateRoots.find((root) => existsSync(root));
  if (!skillsRoot) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== 'scripts' && !RETIRED_PACKAGE_SKILLS.includes(name))
    .filter((name) => existsSync(join(skillsRoot, name, 'SKILL.md')))
    .sort();
}
const packageSkills = discoverPackageSkills();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  });
  if (result.status !== 0) {
    const reason = result.error?.message
      || result.stderr
      || result.stdout
      || (result.signal ? `signal ${result.signal}` : 'unknown subprocess failure');
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal ?? 'spawn'}):\n${reason}`,
    );
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const yarnPath = process.env.npm_execpath;
assert(yarnPath && existsSync(yarnPath), 'pack verification must run through the repository Yarn runtime');
const packLines = run(yarnPath, ['pack', '--dry-run', '--json'], {
  env: { ...process.env, OCTOCODE_VERIFY_PACKAGE_INNER: '1' },
});
// yarn pack --json emits NDJSON, but prepack lifecycle output (yarn build
// banners) is interleaved on the same stdout — parse only valid JSON rows.
const files = packLines.trim().split('\n').flatMap((line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let row;
  try { row = JSON.parse(trimmed); } catch { return []; }
  return row && typeof row === 'object' && row.location ? [String(row.location)] : [];
});
assert(files.length > 0, 'yarn pack --dry-run --json produced no parseable file rows');
for (const required of [
  'LICENSE',
  'README.md',
  'package.json',
  'out/index.js',
  'out/types/src/index.d.ts',
  'out/octocode-awareness.js',
  'out/schema-api.js',
  'out/docs/README.md',
  'out/assets/logo.png',
]) {
  assert(files.includes(required), `packed artifact is missing ${required}`);
}
// Publish surface must nest under one folder (out/) — only the npm-mandated
// root files may live outside it.
const topLevelGroups = new Set(files.map((path) => path.split('/')[0]));
for (const group of topLevelGroups) {
  assert(
    ['out', 'LICENSE', 'README.md', 'package.json'].includes(group),
    `unexpected top-level published path "${group}" — everything but out/, LICENSE, README.md, package.json must nest under out/`,
  );
}
assert(pkg.types === './out/types/src/index.d.ts', `package types must point at the verified declaration entry, got ${String(pkg.types)}`);
assert(readFileSync(join(packageRoot, 'out/types/src/index.d.ts'), 'utf8').includes('export'), 'declaration entry is empty or malformed');
assert(Object.keys(pkg.dependencies ?? {}).length === 0, 'Awareness must keep zero npm runtime dependencies');
assert(!files.some((path) => path.startsWith('dist/')), 'legacy dist/ artifacts must not ship');
assert(packageSkills.length > 0, 'skill discovery found zero skills under package skills/ or out/skills/');
for (const skill of packageSkills) {
  assert(
    files.filter((path) => path.endsWith(`skills/${skill}/SKILL.md`)).length === 1,
    `packed artifact must contain exactly one ${skill} skill tree`,
  );
}
assert(!files.some((path) => path.startsWith('skills/')), 'source skills/ must not duplicate out/skills/');
assert(!files.some((path) => path.endsWith('.map')), 'source maps must not ship in the package');
assert(
  !files.some((path) => path.endsWith('octocode-config.mjs')),
  'gitignored, machine-generated octocode-config.mjs must never be vendored into the published package',
);
for (const path of files.filter((path) => path.startsWith('out/') && !path.startsWith('out/skills/') && /\.(?:m?js)$/.test(path))) {
  const source = readFileSync(join(packageRoot, path), 'utf8');
  assert(
    !source.includes('@octocodeai/octocode-tools-core') && !source.includes('packages/octocode/out/octocode.js'),
    `${path} must not bundle or delegate to the Octocode research CLI`,
  );
}

const isolated = mkdtempSync(join(tmpdir(), 'octocode-awareness-pack-check-'));
try {
  cpSync(join(packageRoot, 'out'), join(isolated, 'out'), { recursive: true });
  cpSync(join(packageRoot, 'README.md'), join(isolated, 'README.md'));
  cpSync(join(packageRoot, 'LICENSE'), join(isolated, 'LICENSE'));
  writeFileSync(join(isolated, 'package.json'), JSON.stringify(pkg));

  const cli = join(isolated, 'out/octocode-awareness.js');
  // Schemas are served dynamically by the CLI — no static out/schemas files.
  const names = JSON.parse(run(process.execPath, [cli, 'schema', 'list', '--compact'], { cwd: isolated }));
  assert(Array.isArray(names) && names.length > 0, 'schema list must return a non-empty schema name array');
  assert(!existsSync(join(isolated, 'out/schemas')), 'static out/schemas must not ship — schemas are served dynamically');
  for (const name of names) {
    const schema = JSON.parse(run(process.execPath, [cli, 'schema', 'json-schema', name, '--compact'], { cwd: isolated }));
    assert(schema && typeof schema === 'object' && schema.type === 'object', `${name} json-schema must be an object schema`);
    const example = run(process.execPath, [cli, 'schema', 'example', name, '--compact'], { cwd: isolated });
    run(process.execPath, [cli, 'schema', 'validate', name, '-', '--compact'], { cwd: isolated, input: example });
  }

  run(process.execPath, [cli, 'maintenance', 'self-test', '--compact'], { cwd: isolated });
  const libraryImport = run(process.execPath, [
    '--input-type=module',
    '--eval',
    `const m = await import(${JSON.stringify(pathToFileURL(join(isolated, 'out/index.js')).href)}); if (!Object.keys(m).length) process.exit(1);`,
  ], { cwd: isolated });
  assert(libraryImport === '', 'importing the library entry must not run the CLI or write output');
} finally {
  rmSync(isolated, { recursive: true, force: true });
}

console.log(`✓ ${pkg.name}@${pkg.version}: isolated zero-dependency package artifact verified (${files.length} files).`);
