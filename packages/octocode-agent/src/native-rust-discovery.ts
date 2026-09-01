import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RuntimeFailure } from "@octocodeai/agent-core";

export interface NativeRustBinaryDiscoveryOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly moduleUrl?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

interface NativeArtifactManifest {
  readonly schemaVersion: 1;
  readonly packageMode: "single-platform" | "multi-platform";
  readonly targets: readonly string[];
}

const NATIVE_TARGET_PATTERN = /^(?:darwin|linux|win32)-[a-z0-9_]+$/u;

function coreBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "octocode-agent-core-rust.exe"
    : "octocode-agent-core-rust";
}

function fileSystemBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "octocode-agent-fs.exe" : "octocode-agent-fs";
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function nativeTarget(platform: NodeJS.Platform, arch: string): string {
  const target = `${platform}-${arch}`;
  if (!NATIVE_TARGET_PATTERN.test(target))
    throw new RuntimeFailure(
      "unsupported-capability",
      `Rust native services are unsupported for ${target}`,
    );
  return target;
}

function invalidNativeArtifactManifest(): never {
  throw new RuntimeFailure(
    "unsupported-capability",
    "Packaged Rust native artifact manifest is unavailable or invalid",
  );
}

function readNativeArtifactManifest(
  manifestPath: string,
): NativeArtifactManifest {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    invalidNativeArtifactManifest();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalidNativeArtifactManifest();
  const manifest = value as Record<string, unknown>;
  const targets = manifest["targets"];
  const packageMode = manifest["packageMode"];
  if (!Array.isArray(targets) || targets.length === 0)
    invalidNativeArtifactManifest();
  const parsedTargets: string[] = [];
  for (const target of targets) {
    if (typeof target !== "string" || !NATIVE_TARGET_PATTERN.test(target))
      invalidNativeArtifactManifest();
    parsedTargets.push(target);
  }
  if (new Set(parsedTargets).size !== parsedTargets.length)
    invalidNativeArtifactManifest();
  if (packageMode !== "single-platform" && packageMode !== "multi-platform")
    invalidNativeArtifactManifest();
  if (
    (packageMode === "single-platform" && parsedTargets.length !== 1) ||
    (packageMode === "multi-platform" && parsedTargets.length < 2)
  )
    invalidNativeArtifactManifest();
  if (manifest["schemaVersion"] !== 1) invalidNativeArtifactManifest();
  return {
    schemaVersion: 1,
    packageMode,
    targets: parsedTargets,
  };
}

function resolveNativeRustBinary(
  options: NativeRustBinaryDiscoveryOptions,
  configuration: {
    readonly override: string | undefined;
    readonly overrideName: string;
    readonly binaryName: (platform: NodeJS.Platform) => string;
    readonly label: string;
  },
): string | undefined {
  const explicit = configuration.override?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit))
      throw new RuntimeFailure(
        "validation",
        `${configuration.overrideName} must be an absolute path`,
      );
    if (!isFile(explicit))
      throw new RuntimeFailure(
        "unsupported-capability",
        `Configured ${configuration.label} binary is unavailable`,
      );
    return explicit;
  }

  const modulePath = fileURLToPath(options.moduleUrl ?? import.meta.url);
  const moduleDirectory = path.dirname(modulePath);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = nativeTarget(platform, arch);
  const isBuiltCli =
    path.basename(modulePath) === "octocode-agent.mjs" &&
    path.basename(moduleDirectory) === "out";
  if (isBuiltCli) {
    const manifest = readNativeArtifactManifest(
      path.join(moduleDirectory, "native", "manifest.json"),
    );
    if (!manifest.targets.includes(target))
      throw new RuntimeFailure(
        "unsupported-capability",
        `Packaged Rust artifacts support ${manifest.targets.join(", ")}, not ${target}`,
      );
  }
  const candidate = path.join(
    moduleDirectory,
    "native",
    target,
    configuration.binaryName(platform),
  );
  if (isFile(candidate)) return candidate;

  if (isBuiltCli)
    throw new RuntimeFailure(
      "unsupported-capability",
      `Packaged ${configuration.label} binary is unavailable for ${platform}-${arch}`,
    );
  return undefined;
}

/** Resolves the explicit override or the data-core binary shipped beside the built CLI. */
export function resolveNativeRustCoreBinary(
  options: NativeRustBinaryDiscoveryOptions,
): string | undefined {
  return resolveNativeRustBinary(options, {
    override: options.env.OCTOCODE_AGENT_RUST_CORE_BIN,
    overrideName: "OCTOCODE_AGENT_RUST_CORE_BIN",
    binaryName: coreBinaryName,
    label: "Rust core",
  });
}

/** Resolves the independent capability-rooted filesystem service. */
export function resolveNativeRustFileSystemBinary(
  options: NativeRustBinaryDiscoveryOptions,
): string | undefined {
  return resolveNativeRustBinary(options, {
    override: options.env.OCTOCODE_AGENT_RUST_FS_BIN,
    overrideName: "OCTOCODE_AGENT_RUST_FS_BIN",
    binaryName: fileSystemBinaryName,
    label: "Rust filesystem",
  });
}
