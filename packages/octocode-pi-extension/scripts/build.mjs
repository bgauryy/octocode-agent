#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(packageRoot, '../..');
const distDir = path.join(packageRoot, 'dist');

const require = createRequire(import.meta.url);

// Resolve workspace/package sources via package resolution — no path hardcoding.
const CONFIG_LOADER_SRC = require.resolve('@octocodeai/config');
const AWARENESS_PACKAGE_ROOT = path.dirname(path.dirname(require.resolve('@octocodeai/octocode-awareness')));
const OCTOCODE_PACKAGE_ROOT = path.dirname(require.resolve('octocode/package.json'));

const SOURCE_PATHS = {
  // TypeScript source is compiled by tsc (see compileTsc()). Only non-code assets — each is copied flat into dist/.
  // are managed here. @octocodeai/config source injected as octocode-config.mjs into every skill that
  // has a scripts/ directory — zero npm publish dependency for standalone skills.
  configLoader: CONFIG_LOADER_SRC,
  awarenessSourceSkills: path.join(AWARENESS_PACKAGE_ROOT, 'skills'),
  subagents: path.join(packageRoot, 'subagents'),
  skills: path.join(packageRoot, 'skills'),
  // The system prompt is composed from per-section files (see src/prompts/compose.mjs),
  // not copied from a single monolithic file.
  promptSections: path.join(packageRoot, 'src', 'prompts', 'sections'),
  // Awareness runtime + bundled skills — bundled at build time so the pi-extension is self-contained.
  awarenessOut: path.join(AWARENESS_PACKAGE_ROOT, 'out'),
  awarenessSkills: path.join(AWARENESS_PACKAGE_ROOT, 'out', 'skills'),
  octocodeSkills: path.join(OCTOCODE_PACKAGE_ROOT, 'skills'),
  // octocode CLI — bundled at build time so the pi-extension is self-contained.
  // Optional in subset checkouts: if missing, the published `octocode` runtime dep is
  // resolved at runtime by getCLIPath() instead and bundleOctocodeCLI() skips gracefully.
  octocodeCLI: path.join(repoRoot, 'packages', 'octocode', 'out'),
};

const OUTPUT_PATHS = {
  extension: path.join(distDir, 'index.js'),
  skills: path.join(distDir, 'skills'),
  subagents: path.join(distDir, 'subagents'),
  systemPrompt: path.join(distDir, 'system', 'SYSTEM_PROMPT.md'),
  // bundled octocode CLI — agent uses: node $OCTOCODE_CLI <command>
  cli: path.join(distDir, 'cli'),
  // bundled Awareness CLI/runtime — agent uses: node $OCTOCODE_AWARENESS_CLI <noun> <verb>
  awareness: path.join(distDir, 'awareness'),
};

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  '__pycache__',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);
const SKIPPED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'npm-debug.log',
  'yarn-error.log',
]);

function isHiddenLocalOnlyEntry(name) {
  return name.startsWith('.') && name !== '.env.example';
}

function shouldSkipEntry(entry) {
  return (
    entry.isSymbolicLink() ||
    isHiddenLocalOnlyEntry(entry.name) ||
    SKIPPED_FILES.has(entry.name) ||
    (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name))
  );
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyDirectory(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (shouldSkipEntry(entry)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      copyFile(sourcePath, targetPath);
    }
  }
}

function copyMarkdownFiles(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    copyFile(
      path.join(sourceDir, entry.name),
      path.join(targetDir, entry.name)
    );
  }
}

function assertRequiredSources() {
  const requiredSources = {
    promptSections: SOURCE_PATHS.promptSections,
  };

  for (const [label, sourcePath] of Object.entries(requiredSources)) {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing ${label} source: ${sourcePath}`);
    }
  }
}

function assertNoHiddenLocalOnlyEntries(targetDir) {
  const violations = [];

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (isHiddenLocalOnlyEntry(entry.name)) {
        violations.push(path.relative(targetDir, entryPath));
      } else if (entry.isDirectory()) {
        walk(entryPath);
      }
    }
  }

  walk(targetDir);

  if (violations.length > 0) {
    throw new Error(
      `Refusing to package hidden local-only entries: ${violations.join(', ')}`
    );
  }
}

/**
 * Copy octocode-config.mjs (the @octocodeai/config source) into every skill's scripts/
 * directory so skills work standalone — no npm publish dependency ever needed.
 * Skill scripts import via: import(new URL('./octocode-config.mjs', import.meta.url).href)
 */
function injectConfigIntoSkills(skillsDir) {
  if (!fs.existsSync(SOURCE_PATHS.configLoader)) {
    throw new Error(
      `Missing config loader source: ${SOURCE_PATHS.configLoader}`
    );
  }
  let injected = 0;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scriptsDir = path.join(skillsDir, entry.name, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      copyFile(
        SOURCE_PATHS.configLoader,
        path.join(scriptsDir, 'octocode-config.mjs')
      );
      injected++;
    }
  }
  return injected;
}

function listSkillNames(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(skillName =>
      fs.existsSync(path.join(skillsDir, skillName, 'SKILL.md'))
    )
    .sort();
}

function assertBundledSkills() {
  return listSkillNames(OUTPUT_PATHS.skills);
}

function clean() {
  fs.rmSync(distDir, { recursive: true, force: true });
}

function copySkillDirectories(sourceRoot, targetRoot) {
  if (!fs.existsSync(sourceRoot)) return 0;
  let copied = 0;
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(sourceRoot, entry.name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
    fs.rmSync(path.join(targetRoot, entry.name), { recursive: true, force: true });
    copyDirectory(src, path.join(targetRoot, entry.name));
    copied++;
  }
  return copied;
}

function refreshPackageSkills() {
  fs.rmSync(SOURCE_PATHS.skills, { recursive: true, force: true });
  fs.mkdirSync(SOURCE_PATHS.skills, { recursive: true });
  // Copy package-local Awareness skill sources when present, then overlay the
  // Awareness package's bundled skill set. This keeps subset checkouts
  // self-contained and avoids repo-root skills as a source or destination.
  const sourceCopied = copySkillDirectories(SOURCE_PATHS.awarenessSourceSkills, SOURCE_PATHS.skills);
  let awarenessCopied = copySkillDirectories(SOURCE_PATHS.awarenessSkills, SOURCE_PATHS.skills);
  const fallbackCopied = awarenessCopied === 0
    ? copySkillDirectories(SOURCE_PATHS.octocodeSkills, SOURCE_PATHS.skills)
    : 0;
  awarenessCopied += fallbackCopied;
  assertNoHiddenLocalOnlyEntries(SOURCE_PATHS.skills);
  if (awarenessCopied === 0) {
    throw new Error(`No Awareness/Octocode skills found in ${SOURCE_PATHS.awarenessSkills} or ${SOURCE_PATHS.octocodeSkills}`);
  }
  return { sourceCopied, awarenessCopied, fallbackCopied };
}

function syncPackageSkills() {
  assertRequiredSources();
  const { sourceCopied, awarenessCopied, fallbackCopied } = refreshPackageSkills();
  const skillNames = listSkillNames(SOURCE_PATHS.skills);
  console.log(`Synced ${skillNames.length} skill(s) into ${SOURCE_PATHS.skills}`);
  if (skillNames.length > 0) console.log(`Skills: ${skillNames.join(', ')}`);
  console.log(`Sources: awareness package skills/ (${sourceCopied}), awareness out/skills/ (${awarenessCopied - fallbackCopied}), octocode fallback skills/ (${fallbackCopied})`);
  return skillNames;
}

/**
 * Bundle the octocode CLI into dist/cli/.
 *
 * Copies the pre-built packages/octocode/out/ directory wholesale.
 * The CLI is self-contained JS (rollup bundles); native engine addons are
 * resolved from the pi-extension's own node_modules at runtime.
 *
 * Prerequisite: `yarn workspace octocode build` must run before this step.
 */
function bundleAwarenessRuntime() {
  const src = SOURCE_PATHS.awarenessOut;
  const dest = OUTPUT_PATHS.awareness;
  const entry = path.join(src, 'octocode-awareness.js');
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Awareness CLI output not found at ${entry}. Run \`yarn workspace @octocodeai/octocode-awareness build\` before building pi-extension.`
    );
  }
  copyDirectory(src, dest);
  console.log(`Awareness CLI bundled: ${dest}/octocode-awareness.js`);
  return dest;
}

function bundleOctocodeCLI() {
  const src = SOURCE_PATHS.octocodeCLI;
  const dest = OUTPUT_PATHS.cli;

  // Optional in subset checkouts that lack the sibling `octocode` package (e.g. a
  // slimmed publish root). When absent, the published `octocode` runtime dependency
  // is resolved from node_modules by getCLIPath() at runtime, so the build can proceed.
  if (!fs.existsSync(src)) {
    console.warn(
      `octocode CLI output not found at ${src} — skipping bundle.\n` +
        `The published \`octocode\` dependency (runtime) provides the CLI instead.\n` +
        `Run \`yarn workspace octocode build\` in the full monorepo to bundle it locally.`
    );
    return null;
  }

  const entry = path.join(src, 'octocode.js');
  if (!fs.existsSync(entry)) {
    console.warn(
      `octocode.js not found in ${src} — skipping bundle. The published \`octocode\` runtime dependency provides the CLI instead.`
    );
    return null;
  }

  copyDirectory(src, dest);
  console.log(`Octocode CLI bundled: ${dest}/octocode.js`);
  return dest;
}

function compileTsc() {
  const candidates = [
    path.join(packageRoot, 'node_modules', '.bin', 'tsc'),
    path.join(packageRoot, '..', '..', 'node_modules', '.bin', 'tsc'),
  ];
  const tscBin = candidates.find(p => fs.existsSync(p));
  if (!tscBin) {
    throw new Error(
      `Could not find tsc binary. Tried:\n${candidates.join('\n')}\nRun: yarn install`
    );
  }
  execSync(`${JSON.stringify(tscBin)} -p tsconfig.build.json`, {
    stdio: 'inherit',
    cwd: packageRoot,
  });
}

async function build() {
  syncPackageSkills();
  clean();

  // 1. Compile TypeScript -> dist/ (generates .js + .d.ts for all src/ modules).
  compileTsc();

  // Inline the @octocodeai/config source AS dist/env.js — index.js imports './env.js', so
  // the published extension carries the loader itself (no runtime dep, nothing to publish).
  // src/env.ts stays a workspace re-export for repo-time (tests, IDE); dist is self-contained.
  copyFile(SOURCE_PATHS.configLoader, path.join(distDir, 'env.js'));
  // Compose the system prompt from its per-section source files into dist/system/.
  // compileTsc() emits dist/prompts/{compose,sections/index}.js; sections/index.js
  // reads its sibling .md files, so copy them next to it, then import the composed prompt.
  copyMarkdownFiles(
    SOURCE_PATHS.promptSections,
    path.join(distDir, 'prompts', 'sections')
  );
  const { SYSTEM_PROMPT } = await import(
    pathToFileURL(path.join(distDir, 'prompts', 'compose.js')).href
  );
  fs.mkdirSync(path.dirname(OUTPUT_PATHS.systemPrompt), { recursive: true });
  fs.writeFileSync(OUTPUT_PATHS.systemPrompt, SYSTEM_PROMPT, 'utf8');
  copyDirectory(SOURCE_PATHS.skills, OUTPUT_PATHS.skills);
  // Copy subagents/ to dist/subagents/ (SYSTEM_PROMPT.md files loaded at runtime)
  if (fs.existsSync(SOURCE_PATHS.subagents)) {
    copyDirectory(SOURCE_PATHS.subagents, OUTPUT_PATHS.subagents);
  }
  // Inject @octocodeai/config source into every skill scripts/ dir — standalone, no npm needed.
  const configInjected = injectConfigIntoSkills(OUTPUT_PATHS.skills);

  bundleAwarenessRuntime();
  bundleOctocodeCLI();

  assertNoHiddenLocalOnlyEntries(distDir);

  const skillNames = assertBundledSkills();
  console.log(
    `Built @octocodeai/pi-extension with ${skillNames.length} skill(s).`
  );
  if (skillNames.length > 0) console.log(`Skills: ${skillNames.join(', ')}`);
  console.log(
    `Config loader: octocode-config.mjs injected into ${configInjected} skill script dir(s)`
  );
}

if (process.argv.includes('--clean')) {
  clean();
} else if (process.argv.includes('--skills-only')) {
  syncPackageSkills();
} else {
  build();
}
