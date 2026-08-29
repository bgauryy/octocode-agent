import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(packageRoot, 'src');
const sourceFiles = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();

const source = (path: string): string => readFileSync(path, 'utf8');
const display = (path: string): string => relative(packageRoot, path);

function localImports(path: string): readonly string[] {
  const imports = source(path).matchAll(/(?:from\s+|import\s*\()(['"])(\.\.?\/[^'"]+)\1/gu);
  return [...imports].flatMap((match) => {
    const specifier = match[2];
    if (specifier === undefined) return [];
    const target = resolve(dirname(path), specifier.replace(/\.js$/u, '.ts'));
    return sourceFiles.includes(target) ? [target] : [];
  });
}

describe('native package architecture', () => {
  it('uses direct internal imports instead of wildcard barrels or index proxies', () => {
    const wildcardExports = sourceFiles.flatMap((path) => /^export\s+\*\s+from\s+/mu.test(source(path))
      ? [display(path)]
      : []);
    const internalIndexImports = sourceFiles.flatMap((path) => localImports(path)
      .filter((target) => target.endsWith('/index.ts'))
      .map((target) => `${display(path)} -> ${display(target)}`));

    expect(wildcardExports).toEqual([]);
    expect(internalIndexImports).toEqual([]);
  });

  it('keeps the OpenTUI dependency graph acyclic', () => {
    const tuiRoot = join(sourceRoot, 'terminal', 'opentui');
    const tuiFiles = sourceFiles.filter((path) => path.startsWith(`${tuiRoot}/`));
    const visited = new Set<string>();
    const active = new Set<string>();
    const cycles: string[] = [];

    const visit = (path: string, trail: readonly string[]): void => {
      if (active.has(path)) {
        const start = trail.indexOf(path);
        cycles.push([...trail.slice(start), path].map(display).join(' -> '));
        return;
      }
      if (visited.has(path)) return;
      active.add(path);
      for (const dependency of localImports(path).filter((item) => tuiFiles.includes(item))) {
        visit(dependency, [...trail, path]);
      }
      active.delete(path);
      visited.add(path);
    };

    for (const path of tuiFiles) visit(path, []);
    expect(cycles).toEqual([]);
  });
});
