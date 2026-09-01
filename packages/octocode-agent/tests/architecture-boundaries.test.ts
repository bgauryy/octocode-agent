import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(packageRoot, "src");
const sourceFiles = readdirSync(sourceRoot, {
  recursive: true,
  withFileTypes: true,
})
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();

const source = (path: string): string => readFileSync(path, "utf8");
const display = (path: string): string => relative(packageRoot, path);

function localImports(path: string): readonly string[] {
  const imports = source(path).matchAll(
    /(?:from\s+|import\s*\()(['"])(\.\.?\/[^'"]+)\1/gu,
  );
  return [...imports].flatMap((match) => {
    const specifier = match[2];
    if (specifier === undefined) return [];
    const target = resolve(dirname(path), specifier.replace(/\.js$/u, ".ts"));
    return sourceFiles.includes(target) ? [target] : [];
  });
}

describe("native package architecture", () => {
  it("uses direct internal imports instead of wildcard barrels or index proxies", () => {
    const wildcardExports = sourceFiles.flatMap((path) =>
      /^export\s+\*\s+from\s+/mu.test(source(path)) ? [display(path)] : [],
    );
    const internalIndexImports = sourceFiles.flatMap((path) =>
      localImports(path)
        .filter((target) => target.endsWith("/index.ts"))
        .map((target) => `${display(path)} -> ${display(target)}`),
    );

    expect(wildcardExports).toEqual([]);
    expect(internalIndexImports).toEqual([]);
  });

  it("imports shared contracts through their owning published subpaths", () => {
    const aggregateSharedImports = sourceFiles.flatMap((path) =>
      /(?:from\s+|import\s*\()(['"])@octocodeai\/octocode-shared\1/u.test(
        source(path),
      )
        ? [display(path)]
        : [],
    );

    expect(aggregateSharedImports).toEqual([]);
  });

  it("keeps the OpenTUI dependency graph acyclic", () => {
    const tuiRoot = join(sourceRoot, "terminal", "opentui");
    const tuiFiles = sourceFiles.filter((path) =>
      path.startsWith(`${tuiRoot}/`),
    );
    const visited = new Set<string>();
    const active = new Set<string>();
    const cycles: string[] = [];

    const visit = (path: string, trail: readonly string[]): void => {
      if (active.has(path)) {
        const start = trail.indexOf(path);
        cycles.push([...trail.slice(start), path].map(display).join(" -> "));
        return;
      }
      if (visited.has(path)) return;
      active.add(path);
      for (const dependency of localImports(path).filter((item) =>
        tuiFiles.includes(item),
      )) {
        visit(dependency, [...trail, path]);
      }
      active.delete(path);
      visited.add(path);
    };

    for (const path of tuiFiles) visit(path, []);
    expect(cycles).toEqual([]);
  });

  it("keeps OpenTUI behind the interactive presentation port", () => {
    const tuiRoot = join(sourceRoot, "terminal", "opentui");
    const boundaryViolations = sourceFiles
      .filter((path) => !path.startsWith(`${tuiRoot}/`))
      .flatMap((path) =>
        localImports(path)
          .filter((target) => target.startsWith(`${tuiRoot}/`))
          .filter(
            (target) =>
              !(
                path === join(sourceRoot, "native-launcher.ts") &&
                target === join(tuiRoot, "renderer.ts")
              ),
          )
          .map((target) => `${display(path)} -> ${display(target)}`),
      );

    expect(boundaryViolations).toEqual([]);
  });

  it("keeps session projection and presentation translation out of the launcher", () => {
    const launcher = source(join(sourceRoot, "native-launcher.ts"));

    expect(launcher).not.toContain(
      "export function createRuntimeEventPersister",
    );
    expect(launcher).not.toContain("function presentationEvents");
    expect(launcher).not.toContain("async function runInteractive");
  });

  it("uses presentation contracts directly instead of publishing adapter aliases", () => {
    const presentation = source(
      join(sourceRoot, "terminal", "opentui", "presentation.ts"),
    );

    expect(
      presentation.match(/^export type \w+ = NativePresentation\w+;$/gmu) ?? [],
    ).toEqual([]);
  });

  it("keeps private atomic-file durability in one filesystem adapter", () => {
    const settings = source(join(sourceRoot, "native-settings.ts"));
    const sessions = source(join(sourceRoot, "native-session-store.ts"));

    expect(settings).toContain("writePrivateFileAtomic");
    expect(settings).not.toContain("#atomic(");
    expect(sessions).toContain("writePrivateFileAtomic");
    expect(sessions).not.toContain("#writeAtomic(");
  });

  it("delegates provider wire formats to Vercel AI SDK instead of owning rigid serializers", () => {
    const packageJson = JSON.parse(
      source(join(packageRoot, "package.json")),
    ) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = packageJson.dependencies ?? {};
    expect(dependencies).toMatchObject({
      ai: "7.0.84",
      "@ai-sdk/openai": "4.0.51",
      "@ai-sdk/anthropic": "4.0.45",
      "@ai-sdk/openai-compatible": "3.0.40",
    });
    expect(dependencies).not.toHaveProperty("openai");
    expect(sourceFiles.map((path) => display(path))).not.toEqual(
      expect.arrayContaining([
        "src/native-openai-responses-model.ts",
        "src/native-anthropic-messages-model.ts",
      ]),
    );
    const adapter = source(join(sourceRoot, "native-model.ts"));
    expect(adapter).toContain("from 'ai'");
    expect(adapter).toContain("from '@ai-sdk/openai'");
    expect(adapter).toContain("from '@ai-sdk/anthropic'");
    expect(adapter).toContain("from '@ai-sdk/openai-compatible'");
    expect(adapter).not.toMatch(
      /TextDecoderStream|response\.completed|content_block_delta/u,
    );
  });
});
