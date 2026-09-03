import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { correlationId, packetId, sessionId, workerId, type WorkerSpawnPacket, type WorkerTerminalPacket } from "@octocodeai/agent-core";
import { createNodeNativeGitProcessAdapter } from "../src/native-workers.js";
import { NativeOwnedWorkerWorktreePort, type NativeWorkerWorktreeRecordV1, type NativeWorkerWorktreeStore } from "../src/native-worker-worktrees.js";
import { NativeRustCoreClient } from "../src/native-rust-core.js";
import { NativeRustWorkerWorktreeStore } from "../src/native-rust-worker-lifecycle.js";

class MemoryStore implements NativeWorkerWorktreeStore {
  record?: NativeWorkerWorktreeRecordV1;
  async reserve(record: NativeWorkerWorktreeRecordV1): Promise<NativeWorkerWorktreeRecordV1> {
    this.record ??= record;
    return this.record;
  }
  async transition(input: Parameters<NativeWorkerWorktreeStore["transition"]>[0]): Promise<NativeWorkerWorktreeRecordV1> {
    assert.ok(this.record);
    assert.equal(this.record.generation, input.generation);
    assert.ok(input.from.includes(this.record.state));
    this.record = { ...this.record, state: input.to, ...(input.headOid === undefined ? {} : { headOid: input.headOid }), ...(input.cleanStatusDigest === undefined ? {} : { cleanStatusDigest: input.cleanStatusDigest }) };
    return this.record;
  }
  async read(digest: string): Promise<NativeWorkerWorktreeRecordV1 | undefined> {
    return this.record?.authorityDigest === digest ? this.record : undefined;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function spawn(baseRevision: string): WorkerSpawnPacket {
  const wid = workerId("owned-worker");
  const cid = correlationId("owned-correlation");
  const sid = sessionId("owned-session");
  return {
    schemaVersion: 1,
    type: "worker.spawn",
    packetId: packetId("owned-spawn"),
    workerId: wid,
    correlationId: cid,
    sessionId: sid,
    redaction: "internal",
    authority: { schemaVersion: 1, workerId: wid, correlationId: cid, rootAgentId: "root", parentSessionId: sid, workspaceId: "workspace", workspaceGeneration: 3, trustRevision: "trust", permissionMode: "default", capabilityDigest: "capability", effectAdmissionId: "effect", ownershipGeneration: 7 },
    prompt: "work",
    promptSnapshotId: "prompt",
    workspace: { mode: "worktree", path: "/caller/must/not/control", baseRevision },
    capabilities: { tools: [], models: [], maxTurns: 1 },
  };
}

test("owned worktree resolves before mutation, generates and locks its path, and discards without force", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-owned-worktree-"));
  const repo = path.join(root, "repo");
  const worktrees = path.join(root, "worktrees");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const store = new MemoryStore();
  const port = new NativeOwnedWorkerWorktreePort({ repositoryRoot: repo, worktreesRoot: worktrees, store, git: createNodeNativeGitProcessAdapter(), release: () => "discard" });
  const prepared = await port.prepare(spawn("HEAD"), new AbortController().signal);
  assert.equal(prepared.workspace.mode, "worktree");
  if (prepared.workspace.mode !== "worktree") return;
  assert.equal(prepared.workspace.path.startsWith(`${fs.realpathSync(worktrees)}${path.sep}`), true);
  assert.notEqual(prepared.workspace.path, "/caller/must/not/control");
  assert.equal(store.record?.state, "active");
  const terminal: WorkerTerminalPacket = { schemaVersion: 1, type: "worker.terminal", packetId: packetId("terminal"), workerId: prepared.workerId, correlationId: prepared.correlationId, sessionId: prepared.sessionId, redaction: "internal", authority: prepared.authority, outcome: "failed" };
  await port.release(prepared, terminal);
  assert.equal(store.record?.state, "discarded");
  assert.equal(fs.existsSync(prepared.workspace.path), false);
});

test("unresolved base revision fails before reserving or creating a worktree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-owned-worktree-invalid-"));
  const repo = path.join(root, "repo");
  const worktrees = path.join(root, "worktrees");
  fs.mkdirSync(repo);
  git(repo, "init");
  const store = new MemoryStore();
  const port = new NativeOwnedWorkerWorktreePort({ repositoryRoot: repo, worktreesRoot: worktrees, store, git: createNodeNativeGitProcessAdapter() });
  await assert.rejects(port.prepare(spawn("missing-revision"), new AbortController().signal));
  assert.equal(store.record, undefined);
  assert.deepEqual(fs.readdirSync(worktrees), []);
});

test("dirty owned worktree is retained and never force-removed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-owned-worktree-dirty-"));
  const repo = path.join(root, "repo");
  const worktrees = path.join(root, "worktrees");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const store = new MemoryStore();
  const port = new NativeOwnedWorkerWorktreePort({ repositoryRoot: repo, worktreesRoot: worktrees, store, git: createNodeNativeGitProcessAdapter(), release: () => "discard" });
  const prepared = await port.prepare(spawn("HEAD"), new AbortController().signal);
  if (prepared.workspace.mode !== "worktree") throw new Error("expected worktree");
  fs.writeFileSync(path.join(prepared.workspace.path, "user-change.txt"), "preserve me\n");
  const terminal: WorkerTerminalPacket = { schemaVersion: 1, type: "worker.terminal", packetId: packetId("dirty-terminal"), workerId: prepared.workerId, correlationId: prepared.correlationId, sessionId: prepared.sessionId, redaction: "internal", authority: prepared.authority, outcome: "failed" };
  await expect(port.release(prepared, terminal)).rejects.toThrow(/dirty/u);
  expect(fs.readFileSync(path.join(prepared.workspace.path, "user-change.txt"), "utf8")).toBe("preserve me\n");
  expect(store.record?.state).toBe("active");
});

const rustBinary = path.resolve(import.meta.dirname, "../../octocode-agent-core-rust/target/debug/octocode-agent-core-rust");
test.skipIf(!fs.existsSync(rustBinary))("creates and discards an owned Git worktree through the real Rust store", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-owned-worktree-rust-"));
  const repo = path.join(root, "repo");
  const worktrees = path.join(root, "worktrees");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const client = new NativeRustCoreClient({ binaryPath: rustBinary, dbPath: path.join(root, "core.sqlite3") });
  try {
    const port = new NativeOwnedWorkerWorktreePort({ repositoryRoot: repo, worktreesRoot: worktrees, store: new NativeRustWorkerWorktreeStore(client), git: createNodeNativeGitProcessAdapter(), release: () => "discard" });
    const prepared = await port.prepare(spawn("HEAD"), new AbortController().signal);
    if (prepared.workspace.mode !== "worktree") throw new Error("expected worktree");
    expect(fs.existsSync(prepared.workspace.path)).toBe(true);
    await port.release(prepared, { schemaVersion: 1, type: "worker.terminal", packetId: packetId("rust-terminal"), workerId: prepared.workerId, correlationId: prepared.correlationId, sessionId: prepared.sessionId, redaction: "internal", authority: prepared.authority, outcome: "failed" });
    expect(fs.existsSync(prepared.workspace.path)).toBe(false);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
