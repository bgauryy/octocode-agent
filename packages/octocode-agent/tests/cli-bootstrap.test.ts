import { describe, expect, it, vi } from "vitest";

import {
  hasExperimentalFfi,
  requiresInteractiveFfi,
  runWithInteractiveFfi,
} from "../src/cli-bootstrap.js";

describe("interactive FFI bootstrap", () => {
  it("limits FFI bootstrapping to interactive OpenTUI invocations", () => {
    for (const argv of [
      [],
      ["--allow-workers"],
      ["session"],
      ["resume", "session-1"],
    ]) {
      expect(requiresInteractiveFfi(argv), argv.join(" ")).toBe(true);
    }

    for (const argv of [
      ["--help"],
      ["run", "hello"],
      ["serve"],
      ["acp"],
      ["sessions"],
      ["session", "--help"],
      ["session", "--print", "hello"],
      ["session", "--mode", "json", "hello"],
      ["--mode", "rpc"],
    ]) {
      expect(requiresInteractiveFfi(argv), argv.join(" ")).toBe(false);
    }
  });

  it("recognizes direct and NODE_OPTIONS FFI enablement", () => {
    expect(hasExperimentalFfi(["--experimental-ffi"], undefined)).toBe(true);
    expect(hasExperimentalFfi([], "--trace-warnings --experimental-ffi")).toBe(
      true,
    );
    expect(hasExperimentalFfi([], "--trace-warnings")).toBe(false);
  });

  it("relaunches the same CLI once with FFI and preserves arguments", async () => {
    const execve = vi.fn();
    const run = vi.fn(async () => 7);

    await expect(
      runWithInteractiveFfi(["--allow-workers"], run, {
        entrypoint: "/package/out/octocode-agent.mjs",
        execPath: "/node",
        execArgv: ["--trace-warnings"],
        env: { OCTOCODE_HOME: "/tmp/octocode" },
        execve,
      }),
    ).resolves.toBe(0);

    expect(run).not.toHaveBeenCalled();
    expect(execve).toHaveBeenCalledWith(
      "/node",
      [
        "/node",
        "--trace-warnings",
        "--experimental-ffi",
        "--disable-warning=ExperimentalWarning",
        "/package/out/octocode-agent.mjs",
        "--allow-workers",
      ],
      { OCTOCODE_HOME: "/tmp/octocode" },
    );
  });

  it("falls back to a supervised child when execve is unavailable", async () => {
    const spawn = vi.fn(() => ({ status: 0, signal: null }));
    await expect(
      runWithInteractiveFfi([], async () => 7, {
        entrypoint: "C:\\package\\octocode-agent.mjs",
        execPath: "C:\\node.exe",
        execArgv: [],
        env: {},
        execve: null,
        spawn,
      }),
    ).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("runs directly when FFI is already enabled or no UI is requested", async () => {
    const spawn = vi.fn();
    const run = vi.fn(async () => 7);

    await expect(
      runWithInteractiveFfi([], run, {
        entrypoint: "/package/out/octocode-agent.mjs",
        execPath: "/node",
        execArgv: ["--experimental-ffi"],
        env: {},
        execve: null,
        spawn,
      }),
    ).resolves.toBe(7);
    await expect(
      runWithInteractiveFfi(["run", "hello"], run, {
        entrypoint: "/package/out/octocode-agent.mjs",
        execPath: "/node",
        execArgv: [],
        env: {},
        execve: null,
        spawn,
      }),
    ).resolves.toBe(7);

    expect(run).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
  });
});
