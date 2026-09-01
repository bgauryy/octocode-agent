import fs from "node:fs";
import promises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { NativeRustFileSystemClient } from "../src/native-rust-file-system.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => promises.rm(root, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const root = await promises.mkdtemp(path.join(os.tmpdir(), "octocode-rust-fs-"));
  roots.push(root);
  return root;
}

describe("native Rust filesystem client", () => {
  const binary = path.resolve(
    import.meta.dirname,
    "../../octocode-agent-core-rust/target/debug/octocode-agent-fs",
  );

  it.skipIf(!fs.existsSync(binary))(
    "executes the real create, read, replace, and delete lifecycle through the typed port",
    async () => {
      const root = await workspace();
      const client = new NativeRustFileSystemClient({ binaryPath: binary, workspace: root });
      try {
        await expect(client.ready()).resolves.toBeUndefined();
        expect(await client.snapshot("a.txt", 1024, new AbortController().signal)).toBeNull();
        const created = await client.replace(
          { path: "a.txt", content: "hello", expectedSha256: null, maxBytes: 1024 },
          new AbortController().signal,
        );
        expect(created).toMatchObject({ path: "a.txt", bytes: 5, previousSha256: null });
        const snapshot = await client.snapshot("a.txt", 1024, new AbortController().signal);
        expect(snapshot).toMatchObject({
          path: "a.txt",
          content: "hello",
          validUtf8: true,
          bytes: 5,
          sha256: created.sha256,
        });
        await expect(
          client.authorizeExternalPath("a.txt", "input", new AbortController().signal),
        ).resolves.toMatchObject({ path: "a.txt", hostPath: path.join(await promises.realpath(root), "a.txt"), kind: "input" });
        await expect(
          client.authorizeExternalPath("rendered.mp4", "output", new AbortController().signal),
        ).resolves.toMatchObject({ path: "rendered.mp4", hostPath: path.join(await promises.realpath(root), "rendered.mp4"), kind: "output" });
        await expect(
          client.readBinary("a.txt", 1024, new AbortController().signal),
        ).resolves.toMatchObject({
          path: "a.txt",
          contentBase64: Buffer.from("hello").toString("base64"),
          bytes: 5,
          sha256: created.sha256,
        });
        const replaced = await client.replace(
          {
            path: "a.txt",
            content: "world",
            expectedSha256: created.sha256,
            maxBytes: 1024,
          },
          new AbortController().signal,
        );
        expect(replaced.previousSha256).toBe(created.sha256);
        expect(await promises.readFile(path.join(root, "a.txt"), "utf8")).toBe("world");
        await client.delete(
          "a.txt",
          replaced.sha256,
          1024,
          new AbortController().signal,
        );
        await expect(promises.stat(path.join(root, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await client.close();
      }
    },
  );

  it.skipIf(!fs.existsSync(binary))(
    "rejects traversal and treats a pre-dispatch abort as cancellation",
    async () => {
      const root = await workspace();
      const client = new NativeRustFileSystemClient({ binaryPath: binary, workspace: root });
      try {
        await client.ready();
        await expect(
          client.snapshot("../outside", 1024, new AbortController().signal),
        ).rejects.toMatchObject({ category: "validation" });
        const controller = new AbortController();
        controller.abort();
        await expect(client.snapshot("a.txt", 1024, controller.signal)).rejects.toMatchObject({
          category: "cancelled",
        });
      } finally {
        await client.close();
      }
    },
  );

  it("fails a health handshake when the child request stream breaks", async () => {
    const root = await workspace();
    class BrokenInput extends Writable {
      override _write(
        _chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      }
    }
    const process = Object.assign(new EventEmitter(), {
      stdin: new BrokenInput(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    const client = new NativeRustFileSystemClient({
      binaryPath: binary,
      workspace: root,
      spawn: () => process,
    });

    await expect(client.ready()).rejects.toMatchObject({ category: "tool-execution" });
  });
});
