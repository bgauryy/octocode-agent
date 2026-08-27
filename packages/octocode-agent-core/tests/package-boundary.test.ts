import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceFiles = readdirSync(join(packageRoot, 'src'), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();

describe('host-neutral package boundary', () => {
  it('has no runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { dependencies?: unknown; peerDependencies?: unknown; optionalDependencies?: unknown };
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('imports no Pi, OpenTUI, launcher, browser, DOM, or filesystem modules', () => {
    const forbidden = /(?:from\s+|import\s*\()(?:['"])(?:@earendil-works\/pi-|@opentui\/|\.\.\/\.\.\/(?:octocode-agent|octocode-pi-extension)|node:(?:fs|path)|(?:fs|path|chrome-launcher))[^'"]*['"]/;
    const violations = sourceFiles.flatMap((path) => forbidden.test(readFileSync(path, 'utf8')) ? [path] : []);
    expect(violations).toEqual([]);
  });
});
