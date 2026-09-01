#!/usr/bin/env node
/**
 * octocode-agent build script.
 * Single ESM bundle plus a manifest-declared set of native Rust artifacts.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseOptions } from "../../../build.config.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = join(packageRoot, "out");
const outfile = join(packageRoot, "out", "octocode-agent.mjs");
const publicEntryPoints = {
  "api/v1": join(packageRoot, "src", "api", "v1.ts"),
  "presentation/v1": join(packageRoot, "src", "presentation", "v1.ts"),
};
const rustRoot = resolve(packageRoot, "..", "octocode-agent-core-rust");
const nativeRoot = join(outRoot, "native");
const nativeTargetPattern = /^(?:darwin|linux|win32)-[a-z0-9_]+$/u;
const stagedArtifactsValue =
  process.env.OCTOCODE_AGENT_NATIVE_ARTIFACTS_DIR?.trim();
const requiredPlatforms = (
  process.env.OCTOCODE_AGENT_REQUIRED_NATIVE_PLATFORMS ?? ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function binaryNames(target) {
  const platform = target.slice(0, target.indexOf("-"));
  return platform === "win32"
    ? ["octocode-agent-core-rust.exe", "octocode-agent-fs.exe"]
    : ["octocode-agent-core-rust", "octocode-agent-fs"];
}

async function assertFile(file) {
  let metadata;
  try {
    metadata = await stat(file);
  } catch {
    throw new Error(`Required native artifact is unavailable: ${file}`);
  }
  if (!metadata.isFile())
    throw new Error(`Required native artifact is not a file: ${file}`);
}

async function copyTarget(sourceDirectory, target) {
  if (!nativeTargetPattern.test(target))
    throw new Error(`Invalid native artifact target: ${target}`);
  const destinationRoot = join(nativeRoot, target);
  await mkdir(destinationRoot, { recursive: true });
  for (const binaryName of binaryNames(target)) {
    const source = join(sourceDirectory, binaryName);
    const destination = join(destinationRoot, binaryName);
    await assertFile(source);
    await copyFile(source, destination);
    await chmod(destination, 0o755);
  }
}

function assertRequiredPlatforms(targets) {
  const declaredPlatforms = new Set(
    targets.map((target) => target.slice(0, target.indexOf("-"))),
  );
  for (const platform of requiredPlatforms) {
    if (!["darwin", "linux", "win32"].includes(platform))
      throw new Error(`Invalid required native platform: ${platform}`);
    if (!declaredPlatforms.has(platform))
      throw new Error(
        `Staged native artifacts omit required platform: ${platform}`,
      );
  }
}

async function stageNativeArtifacts() {
  if (stagedArtifactsValue) {
    if (!isAbsolute(stagedArtifactsValue))
      throw new Error(
        "OCTOCODE_AGENT_NATIVE_ARTIFACTS_DIR must be an absolute path",
      );
    const stagedRoot = resolve(stagedArtifactsValue);
    const stagedRelativeToOut = relative(outRoot, stagedRoot);
    if (
      stagedRelativeToOut === "" ||
      (!stagedRelativeToOut.startsWith("..") &&
        !isAbsolute(stagedRelativeToOut))
    )
      throw new Error(
        "OCTOCODE_AGENT_NATIVE_ARTIFACTS_DIR must be outside the build output",
      );
    const entries = await readdir(stagedRoot, { withFileTypes: true });
    const targets = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (targets.length === 0)
      throw new Error(
        "OCTOCODE_AGENT_NATIVE_ARTIFACTS_DIR contains no target directories",
      );
    assertRequiredPlatforms(targets);
    for (const target of targets)
      await copyTarget(join(stagedRoot, target), target);
    return targets;
  }

  if (requiredPlatforms.length > 0)
    throw new Error(
      "OCTOCODE_AGENT_REQUIRED_NATIVE_PLATFORMS requires OCTOCODE_AGENT_NATIVE_ARTIFACTS_DIR",
    );
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      join(rustRoot, "Cargo.toml"),
    ],
    { stdio: "inherit" },
  );
  const target = `${process.platform}-${process.arch}`;
  const releaseRoot = join(rustRoot, "target", "release");
  await copyTarget(releaseRoot, target);
  return [target];
}

await rm(outRoot, { recursive: true, force: true });

const runtimeBanner =
  "import { createRequire as __octocodeCreateRequire } from 'node:module';\nconst require = __octocodeCreateRequire(import.meta.url);";
const runtimeExternals = [
  ...baseOptions.external,
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/client/*",
  "ajv",
  "yaml",
];

await build({
  ...baseOptions,
  entryPoints: [join(packageRoot, "src", "cli.ts")],
  outfile,
  // Keep runtime protocol libraries external. The MCP client includes CommonJS
  // process helpers that cannot be safely inlined into the ESM executable.
  external: runtimeExternals,
  // Some bundled AI SDK dependencies still contain dynamic CommonJS requires.
  // Provide an ESM-local require so builtins such as `path` remain available in
  // the single-file executable on modern Node releases.
  banner: {
    js: `#!/usr/bin/env node\n${runtimeBanner}`,
  },
  minify: false,
});

await chmod(outfile, 0o755);

await build({
  ...baseOptions,
  entryPoints: publicEntryPoints,
  outdir: outRoot,
  external: runtimeExternals,
  banner: { js: runtimeBanner },
  minify: false,
});

execFileSync(
  process.execPath,
  [
    resolve(packageRoot, "..", "..", "node_modules", "typescript", "bin", "tsc"),
    "--emitDeclarationOnly",
    "--project",
    join(packageRoot, "tsconfig.json"),
    "--outDir",
    outRoot,
  ],
  { stdio: "inherit" },
);

const nativeTargets = await stageNativeArtifacts();
await writeFile(
  join(nativeRoot, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      packageMode:
        nativeTargets.length === 1 ? "single-platform" : "multi-platform",
      targets: nativeTargets,
    },
    null,
    2,
  )}\n`,
);
