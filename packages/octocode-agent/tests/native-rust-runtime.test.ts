import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ToolRegistry } from "@octocodeai/agent-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDefaultNativeRuntime,
  parseNativeArgs,
} from "../src/native-launcher.js";
import { NativeRustCoreClient } from "../src/native-rust-core.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("native Rust runtime integration", () => {
  const binary = path.resolve(
    import.meta.dirname,
    "../../octocode-agent-core-rust/target/debug/octocode-agent-core-rust",
  );

  it.skipIf(!fs.existsSync(binary))(
    "persists and resumes a real runtime through the opt-in Rust core",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "octocode-rust-runtime-"),
      );
      roots.push(root);
      const home = path.join(root, "home");
      const cwd = path.join(root, "workspace");
      const dbPath = path.join(root, "core.sqlite3");
      fs.mkdirSync(home);
      fs.mkdirSync(cwd);
      const env = {
        OCTOCODE_HOME: home,
        OCTOCODE_AGENT_RUST_CORE_BIN: binary,
        OCTOCODE_AGENT_RUST_CORE_DB: dbPath,
      };
      const args = parseNativeArgs(["--session", "rust-runtime"]);
      const model = {
        run: async () => ({
          stop: "complete" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      };

      const first = await createDefaultNativeRuntime({
        env,
        cwd,
        args,
        tools: new ToolRegistry(),
        model,
      });
      await first.stop();
      const second = await createDefaultNativeRuntime({
        env,
        cwd,
        args,
        tools: new ToolRegistry(),
        model,
      });
      await second.stop();

      const client = new NativeRustCoreClient({ binaryPath: binary, dbPath });
      try {
        const loaded = await client.sessionLoad({ sessionId: "rust-runtime" });
        expect(loaded).toMatchObject({ sessionId: "rust-runtime" });
        expect(BigInt(loaded?.revision ?? "0")).toBeGreaterThan(0n);
        expect(loaded?.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: expect.objectContaining({ type: "session.created" }),
            }),
          ]),
        );
        await expect(client.sessionList({ cwd, limit: 10 })).resolves.toEqual([
          expect.objectContaining({ sessionId: "rust-runtime", cwd }),
        ]);
      } finally {
        await client.close();
      }
    },
  );
});
