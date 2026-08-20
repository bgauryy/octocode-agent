#!/usr/bin/env node
/**
 * Pin the bundled core (`@octocodeai/pi-extension`) from the `workspace:` protocol
 * to a real semver so a standalone `npm publish` from this checkout succeeds.
 *
 * The canonical release flow pins versions from the sibling `octocode` monorepo,
 * but that leaves a plain `npm publish` here broken (workspace: → EUNSUPPORTEDPROTOCOL,
 * caught by check-no-workspace-protocol.mjs). This script makes the pin self-sufficient:
 * it reads the workspace pi-extension's actual version and writes `^<version>` into
 * this package's dependencies, so prepack's guard passes.
 *
 * Usage:
 *   node scripts/sync-version.mjs            # pin from the workspace pi-extension version
 *   node scripts/sync-version.mjs --check    # report only, non-zero exit if a pin is needed
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_PACKAGE = '@octocodeai/pi-extension';
const checkOnly = process.argv.includes('--check');

const pkgPath = join(packageRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// Resolve the workspace pi-extension version (sibling package in the monorepo).
const corePkgPath = join(packageRoot, '..', 'octocode-pi-extension', 'package.json');
let coreVersion;
try {
  coreVersion = JSON.parse(readFileSync(corePkgPath, 'utf8')).version;
} catch {
  console.error(`✗ sync-version: cannot read ${corePkgPath} to resolve ${CORE_PACKAGE} version.`);
  process.exit(1);
}
if (!coreVersion) {
  console.error(`✗ sync-version: ${CORE_PACKAGE} has no version field.`);
  process.exit(1);
}

const current = pkg.dependencies?.[CORE_PACKAGE];
const pinned = `^${coreVersion}`;

if (current === pinned) {
  console.log(`✓ sync-version: ${CORE_PACKAGE} already pinned to ${pinned}.`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`✗ sync-version: ${CORE_PACKAGE} is "${current}" — needs pin to ${pinned}. Run: yarn sync:version:publish`);
  process.exit(1);
}

pkg.dependencies[CORE_PACKAGE] = pinned;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`✓ sync-version: pinned ${CORE_PACKAGE} "${current}" → "${pinned}".`);
