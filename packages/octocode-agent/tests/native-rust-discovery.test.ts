import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RuntimeFailure } from "@octocodeai/agent-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveNativeRustCoreBinary,
  resolveNativeRustFileSystemBinary,
} from "../src/native-rust-discovery.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  root: string;
  moduleUrl: string;
  binary: string;
  manifest: string;
  target: string;
} {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "octocode-rust-discovery-"),
  );
  roots.push(root);
  const out = path.join(root, "out");
  const target = `${process.platform}-${process.arch}`;
  const binary = path.join(
    out,
    "native",
    target,
    process.platform === "win32"
      ? "octocode-agent-core-rust.exe"
      : "octocode-agent-core-rust",
  );
  return {
    root,
    moduleUrl: pathToFileURL(path.join(out, "octocode-agent.mjs")).href,
    binary,
    manifest: path.join(out, "native", "manifest.json"),
    target,
  };
}

function writeManifest(
  value: ReturnType<typeof fixture>,
  targets: readonly string[] = [value.target],
): void {
  fs.mkdirSync(path.dirname(value.manifest), { recursive: true });
  fs.writeFileSync(
    value.manifest,
    `${JSON.stringify({
      schemaVersion: 1,
      packageMode: targets.length === 1 ? "single-platform" : "multi-platform",
      targets,
    })}\n`,
  );
}

function fsBinary(root: string): string {
  return path.join(
    root,
    "out",
    "native",
    `${process.platform}-${process.arch}`,
    process.platform === "win32"
      ? "octocode-agent-fs.exe"
      : "octocode-agent-fs",
  );
}

describe("resolveNativeRustCoreBinary", () => {
  it("discovers the platform binary beside the built CLI", () => {
    const value = fixture();
    fs.mkdirSync(path.dirname(value.binary), { recursive: true });
    fs.writeFileSync(value.binary, "fixture");
    writeManifest(value);

    expect(
      resolveNativeRustCoreBinary({ env: {}, moduleUrl: value.moduleUrl }),
    ).toBe(value.binary);
  });

  it("preserves an absolute explicit override", () => {
    const value = fixture();
    fs.writeFileSync(path.join(value.root, "core"), "fixture");
    const override = path.join(value.root, "core");

    expect(
      resolveNativeRustCoreBinary({
        env: { OCTOCODE_AGENT_RUST_CORE_BIN: override },
        moduleUrl: value.moduleUrl,
      }),
    ).toBe(override);
  });

  it("fails closed when a built CLI requests persistence without its binary", () => {
    const value = fixture();
    writeManifest(value);
    expect(() =>
      resolveNativeRustCoreBinary({ env: {}, moduleUrl: value.moduleUrl }),
    ).toThrowError(RuntimeFailure);
  });

  it("fails closed when a packaged artifact omits its native manifest", () => {
    const value = fixture();
    fs.mkdirSync(path.dirname(value.binary), { recursive: true });
    fs.writeFileSync(value.binary, "fixture");

    expect(() =>
      resolveNativeRustCoreBinary({ env: {}, moduleUrl: value.moduleUrl }),
    ).toThrowError(/native artifact manifest/i);
  });

  it("rejects hosts that the packaged native manifest does not declare", () => {
    const value = fixture();
    writeManifest(value);
    const otherPlatform: NodeJS.Platform =
      process.platform === "linux" ? "darwin" : "linux";

    expect(() =>
      resolveNativeRustCoreBinary({
        env: {},
        moduleUrl: value.moduleUrl,
        platform: otherPlatform,
      }),
    ).toThrowError(
      `Packaged Rust artifacts support ${value.target}, not ${otherPlatform}-${process.arch}`,
    );
  });

  it("keeps the source-runtime fallback until the packaged migration boundary", () => {
    const value = fixture();
    const sourceUrl = pathToFileURL(
      path.join(value.root, "src", "native-launcher.ts"),
    ).href;
    expect(
      resolveNativeRustCoreBinary({ env: {}, moduleUrl: sourceUrl }),
    ).toBeUndefined();
  });
});

describe("resolveNativeRustFileSystemBinary", () => {
  it("discovers the separately packaged filesystem service", () => {
    const value = fixture();
    const binary = fsBinary(value.root);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "fixture");
    writeManifest(value);

    expect(
      resolveNativeRustFileSystemBinary({
        env: {},
        moduleUrl: value.moduleUrl,
      }),
    ).toBe(binary);
  });

  it("uses an independent absolute override and fails closed for packaged builds", () => {
    const value = fixture();
    const override = path.join(value.root, "fs-service");
    fs.writeFileSync(override, "fixture");
    expect(
      resolveNativeRustFileSystemBinary({
        env: { OCTOCODE_AGENT_RUST_FS_BIN: override },
        moduleUrl: value.moduleUrl,
      }),
    ).toBe(override);
    writeManifest(value);
    expect(() =>
      resolveNativeRustFileSystemBinary({
        env: {},
        moduleUrl: value.moduleUrl,
      }),
    ).toThrowError(RuntimeFailure);
  });
});
