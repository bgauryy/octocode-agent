import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export interface AssetPaths {
  baseDir: string;
  docsDir: string;
  skillsDir: string;
  systemPrompt: string;
  /** Absolute path to the bundled octocode CLI entry point (dist/cli/octocode.js). */
  cliPath: string;
}

export function getAssetPaths(baseDir = extensionDir): AssetPaths {
  return {
    baseDir,
    docsDir: path.join(baseDir, 'docs'),
    skillsDir: path.join(baseDir, 'skills'),
    systemPrompt: path.join(baseDir, 'system', 'SYSTEM_PROMPT.md'),
    cliPath: path.join(baseDir, 'cli', 'octocode.js'),
  };
}

/**
 * Returns the absolute path to the bundled octocode CLI entry point.
 * Agents run it with: `node <cliPath> <command>`
 * Also exposed via the OCTOCODE_CLI env var (set at extension load).
 */
export function getCLIPath(baseDir = extensionDir): string {
  // Prefer the build-bundled CLI (dist/cli/octocode.js) — present when the sibling
  // `octocode` package is built in the same monorepo. In checkouts without that
  // sibling, the published `octocode` CLI is a runtime dependency and is resolved
  // from node_modules here, so the agent-facing $OCTOCODE_CLI contract holds either way.
  const bundled = path.join(baseDir, 'cli', 'octocode.js');
  if (fs.existsSync(bundled)) return bundled;
  try {
    const pkgPath = require.resolve('octocode/package.json');
    const root = path.dirname(pkgPath);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.octocode ?? 'out/octocode.js');
    const resolved = path.join(root, bin);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // octocode not installed (pre-install or dev without the dep) — fall through.
  }
  console.warn(
    `[octocode-pi-extension] Warning: CLI not found at ${bundled} or in node_modules. ` +
      `node $OCTOCODE_CLI calls will ENOENT. Run \`yarn install\` or ` +
      `\`yarn workspace @octocodeai/pi-extension build\` to resolve.`,
  );
  return bundled;
}

/**
 * Returns the absolute path to the bundled octocode-awareness CLI entry point
 * (the standalone script shipped with the awareness skill). Agents run it with:
 * `node <awarenessCliPath> <noun> <verb>`. Also exposed via the
 * OCTOCODE_AWARENESS_CLI env var (set at extension load) so bash-spawned CLI
 * calls share the same interface the skill documents.
 *
 * M8: The result is cached per baseDir to avoid repeated fs.existsSync calls AND
 * to suppress the "awareness CLI not found" warning from firing on every turn.
 * The cache is intentional and process-scoped: the CLI path does not change
 * after the extension loads. Tests that need to invalidate it can call
 * `clearAwarenessCLIPathCacheForTests()`.
 */
const _awarenessCliPathCache = new Map<string, string>();

/** Clears the path cache for tests that need to re-resolve the awareness CLI path. */
export function clearAwarenessCLIPathCacheForTests(): void {
  _awarenessCliPathCache.clear();
}

export function getAwarenessCLIPath(baseDir = extensionDir): string {
  const cached = _awarenessCliPathCache.get(baseDir);
  if (cached !== undefined) return cached;
  const bundled = path.join(baseDir, 'skills', 'octocode-awareness', 'scripts', 'awareness.mjs');
  if (fs.existsSync(bundled)) { _awarenessCliPathCache.set(baseDir, bundled); return bundled; }
  // Source-mode tests/dev run from src/, while the build/runtime runs from
  // dist/. Both consume the same generated package-level skill tree.
  const sourceMode = path.join(path.dirname(baseDir), 'skills', 'octocode-awareness', 'scripts', 'awareness.mjs');
  if (fs.existsSync(sourceMode)) { _awarenessCliPathCache.set(baseDir, sourceMode); return sourceMode; }
  // Neither the bundled nor the source-mode awareness.mjs resolved. The bundled
  // path is still returned (and set as $OCTOCODE_AWARENESS_CLI) so the env var is
  // always defined, but warn loudly so the next `node $OCTOCODE_AWARENESS_CLI ...`
  // failure is diagnosable instead of an opaque ENOENT — this points at a broken
  // build where the awareness skill wasn't vendored into dist/skills/. Do NOT throw:
  // load must continue so other extension surfaces (tools, prompts) stay usable.
  console.warn(
    `[octocode-pi-extension] Warning: awareness CLI not found at ${bundled} or ${sourceMode}. ` +
      `A downstream \`node $OCTOCODE_AWARENESS_CLI ...\` call will ENOENT. ` +
      `Rebuild the package (yarn workspace @octocodeai/pi-extension build) to vendor the skill.`
  );
  _awarenessCliPathCache.set(baseDir, bundled);
  return bundled;
}

export function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
    throw error;
  }
}

export function listBundledSkills(baseDir = extensionDir): string[] {
  const { skillsDir } = getAssetPaths(baseDir);
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((skillName) =>
      fs.existsSync(path.join(skillsDir, skillName, 'SKILL.md')),
    )
    .sort();
}

export function getInstallSource(baseDir = extensionDir): string {
  const packageRoot = path.dirname(baseDir);
  if (
    packageRoot.includes(
      path.join('node_modules', '@octocodeai', 'pi-extension'),
    )
  ) {
    return 'npm:@octocodeai/pi-extension';
  }
  return packageRoot;
}
