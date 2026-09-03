import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  RuntimeFailure,
  type WorkerAuthorityV1,
  type WorkerSpawnPacket,
  type WorkerTerminalPacket,
  type WorkerWorktreePort,
} from "@octocodeai/agent-core";

export type NativeWorkerWorktreeState =
  | "requested"
  | "preparing"
  | "active"
  | "ready-to-integrate"
  | "integrating"
  | "integrated"
  | "conflict-retained"
  | "retained"
  | "discarding"
  | "discarded"
  | "recovery-needed";

export interface NativeWorkerWorktreeRecordV1 {
  readonly schemaVersion: 1;
  readonly authorityDigest: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly workerId: string;
  readonly repositoryRoot: string;
  readonly commonDir: string;
  readonly path: string;
  readonly gitWorktreeId: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly privateRef: string;
  readonly lockReasonDigest: string;
  readonly generation: number;
  readonly state: NativeWorkerWorktreeState;
  readonly cleanStatusDigest?: string;
}

export interface NativeWorkerWorktreeStore {
  reserve(record: NativeWorkerWorktreeRecordV1, authority: WorkerAuthorityV1): Promise<NativeWorkerWorktreeRecordV1>;
  transition(input: {
    readonly authority: WorkerAuthorityV1;
    readonly authorityDigest: string;
    readonly generation: number;
    readonly from: readonly NativeWorkerWorktreeState[];
    readonly to: NativeWorkerWorktreeState;
    readonly headOid?: string;
    readonly cleanStatusDigest?: string;
  }): Promise<NativeWorkerWorktreeRecordV1>;
  read(authorityDigest: string, authority: WorkerAuthorityV1): Promise<NativeWorkerWorktreeRecordV1 | undefined>;
}

export interface NativeWorkerGitPort {
  run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export interface NativeOwnedWorkerWorktreeOptions {
  readonly repositoryRoot: string;
  readonly worktreesRoot: string;
  readonly store: NativeWorkerWorktreeStore;
  readonly git: NativeWorkerGitPort;
  readonly release?: (terminal: WorkerTerminalPacket) => "retain" | "discard";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim() || value.includes("\0")) throw new RuntimeFailure("validation", `${label} is invalid`);
  return value;
}

function canonicalDirectory(value: string, label: string): string {
  const resolved = path.resolve(nonEmpty(value, label));
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new RuntimeFailure("validation", `${label} must be a directory`);
  return fs.realpathSync(resolved);
}

export function nativeWorkerAuthorityDigest(authority: WorkerAuthorityV1): string {
  return sha256(JSON.stringify([
    authority.schemaVersion,
    authority.workerId,
    authority.correlationId,
    authority.rootAgentId,
    authority.parentSessionId,
    authority.workspaceId,
    authority.workspaceGeneration,
    authority.trustRevision,
    authority.permissionMode,
    authority.capabilityDigest,
    authority.planId ?? null,
    authority.planRevision ?? null,
    authority.planStepId ?? null,
    authority.effectAdmissionId,
    authority.ownershipGeneration,
  ]));
}

interface PorcelainWorktree {
  readonly path: string;
  readonly head?: string;
  readonly detached: boolean;
  readonly lockReason?: string;
}

function parseWorktreePorcelainZ(value: string): readonly PorcelainWorktree[] {
  const records: PorcelainWorktree[] = [];
  let current: { path?: string; head?: string; detached: boolean; lockReason?: string } = { detached: false };
  for (const field of value.split("\0")) {
    if (field === "") {
      if (current.path !== undefined) records.push({
        path: current.path,
        detached: current.detached,
        ...(current.head === undefined ? {} : { head: current.head }),
        ...(current.lockReason === undefined ? {} : { lockReason: current.lockReason }),
      });
      current = { detached: false };
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const payload = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") current.path = payload;
    else if (key === "HEAD") current.head = payload;
    else if (key === "detached") current.detached = true;
    else if (key === "locked") current.lockReason = payload;
  }
  return records;
}

/** Git semantics for positively owned, generation-fenced worker worktrees. */
export class NativeOwnedWorkerWorktreePort implements WorkerWorktreePort {
  readonly #repositoryRoot: string;
  readonly #worktreesRoot: string;
  readonly #store: NativeWorkerWorktreeStore;
  readonly #git: NativeWorkerGitPort;
  readonly #releasePolicy: (terminal: WorkerTerminalPacket) => "retain" | "discard";

  constructor(options: NativeOwnedWorkerWorktreeOptions) {
    this.#repositoryRoot = canonicalDirectory(options.repositoryRoot, "Worker repository root");
    fs.mkdirSync(path.resolve(options.worktreesRoot), { recursive: true });
    this.#worktreesRoot = canonicalDirectory(options.worktreesRoot, "Worker worktrees root");
    this.#store = options.store;
    this.#git = options.git;
    this.#releasePolicy = options.release ?? (() => "retain");
  }

  async prepare(packet: WorkerSpawnPacket, signal: AbortSignal): Promise<WorkerSpawnPacket> {
    if (packet.workspace.mode === "shared") return packet;
    if (signal.aborted) throw new RuntimeFailure("cancelled", "Worker worktree preparation was cancelled");
    const authorityDigest = nativeWorkerAuthorityDigest(packet.authority);
    const revision = nonEmpty(packet.workspace.baseRevision, "Worker base revision");
    const baseOid = (await this.#git.run(this.#repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`], signal)).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/u.test(baseOid)) throw new RuntimeFailure("validation", "Worker base revision did not resolve to a commit OID");
    const commonRaw = (await this.#git.run(this.#repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).stdout.trim();
    const commonDir = fs.realpathSync(path.resolve(this.#repositoryRoot, commonRaw));
    const generation = packet.authority.ownershipGeneration;
    const suffix = sha256(`${packet.sessionId}\0${packet.workerId}\0${generation}`).slice(0, 24);
    const target = path.join(this.#worktreesRoot, `worker-${suffix}`);
    const relative = path.relative(this.#worktreesRoot, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new RuntimeFailure("internal-invariant", "Generated worker path escaped its root");
    const privateRef = `refs/octocode/workers/${encodeURIComponent(String(packet.sessionId))}/${encodeURIComponent(String(packet.workerId))}/${generation}`;
    const lockReason = `octocode-worker:${authorityDigest}`;
    const requested: NativeWorkerWorktreeRecordV1 = Object.freeze({
      schemaVersion: 1,
      authorityDigest,
      workspaceId: packet.authority.workspaceId,
      sessionId: String(packet.sessionId),
      workerId: String(packet.workerId),
      repositoryRoot: this.#repositoryRoot,
      commonDir,
      path: target,
      gitWorktreeId: suffix,
      baseOid,
      headOid: baseOid,
      privateRef,
      lockReasonDigest: sha256(lockReason),
      generation,
      state: "requested",
    });
    const reserved = await this.#store.reserve(requested, packet.authority);
    this.#assertExactRecord(requested, reserved);
    if (reserved.state === "discarded") throw new RuntimeFailure("conflict", "Discarded worker worktree generation cannot be reused");
    if (!fs.existsSync(target)) {
      await this.#store.transition({ authority: packet.authority, authorityDigest, generation, from: ["requested", "recovery-needed"], to: "preparing" });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await this.#git.run(this.#repositoryRoot, ["worktree", "add", "--detach", "--lock", "--reason", lockReason, target, baseOid], signal);
    }
    await this.#verifyGitRecord(target, baseOid, lockReason, signal);
    const cleanStatusDigest = await this.#cleanDigest(target, signal);
    await this.#store.transition({
      authorityDigest,
      authority: packet.authority,
      generation,
      from: ["requested", "preparing", "active", "retained", "recovery-needed"],
      to: "active",
      headOid: baseOid,
      cleanStatusDigest,
    });
    return Object.freeze({ ...packet, workspace: Object.freeze({ mode: "worktree", path: target, baseRevision: baseOid }) });
  }

  async release(packet: WorkerSpawnPacket, terminal: WorkerTerminalPacket): Promise<void> {
    if (packet.workspace.mode === "shared") return;
    const authorityDigest = nativeWorkerAuthorityDigest(packet.authority);
    const record = await this.#ownedRecord(packet.authority, authorityDigest);
    const currentHead = await this.#verifyGitRecord(record.path, undefined, `octocode-worker:${authorityDigest}`);
    try {
      await this.#git.run(record.path, ["merge-base", "--is-ancestor", record.baseOid, currentHead]);
    } catch {
      throw new RuntimeFailure("conflict", "Worker worktree HEAD is not descended from its owned base");
    }
    if (this.#releasePolicy(terminal) === "discard") {
      await this.#discard(record, packet.authority);
      return;
    }
    if (terminal.outcome !== "succeeded") {
      await this.#store.transition({ authority: packet.authority, authorityDigest, generation: record.generation, from: ["active", "recovery-needed"], to: "retained" });
      return;
    }
    const status = await this.#git.run(record.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.stdout.length > 0) {
      await this.#git.run(record.path, ["add", "--all"]);
      await this.#git.run(record.path, ["-c", "user.name=Octocode", "-c", "user.email=worker@octocode.invalid", "commit", "--allow-empty", "-m", `Octocode worker ${record.workerId}`]);
    }
    const headOid = (await this.#git.run(record.path, ["rev-parse", "HEAD"])).stdout.trim();
    await this.#git.run(this.#repositoryRoot, ["update-ref", record.privateRef, headOid]);
    await this.#store.transition({ authority: packet.authority, authorityDigest, generation: record.generation, from: ["active"], to: "ready-to-integrate", headOid, cleanStatusDigest: await this.#cleanDigest(record.path) });
  }

  async discard(authority: WorkerAuthorityV1): Promise<void> {
    const digest = nativeWorkerAuthorityDigest(authority);
    await this.#discard(await this.#ownedRecord(authority, digest), authority);
  }

  async #discard(record: NativeWorkerWorktreeRecordV1, authority: WorkerAuthorityV1): Promise<void> {
    await this.#verifyGitRecord(record.path, undefined, `octocode-worker:${record.authorityDigest}`);
    const cleanStatusDigest = await this.#cleanDigest(record.path);
    await this.#store.transition({ authority, authorityDigest: record.authorityDigest, generation: record.generation, from: ["active", "ready-to-integrate", "retained", "conflict-retained", "recovery-needed"], to: "discarding", cleanStatusDigest });
    await this.#git.run(this.#repositoryRoot, ["worktree", "unlock", record.path]);
    await this.#git.run(this.#repositoryRoot, ["worktree", "remove", record.path]);
    await this.#store.transition({ authority, authorityDigest: record.authorityDigest, generation: record.generation, from: ["discarding"], to: "discarded", cleanStatusDigest });
  }

  async #ownedRecord(authority: WorkerAuthorityV1, authorityDigest: string): Promise<NativeWorkerWorktreeRecordV1> {
    const record = await this.#store.read(authorityDigest, authority);
    if (record === undefined || record.workspaceId !== authority.workspaceId || record.generation !== authority.ownershipGeneration) {
      throw new RuntimeFailure("conflict", "Worker worktree ownership could not be proven");
    }
    return record;
  }

  #assertExactRecord(expected: NativeWorkerWorktreeRecordV1, actual: NativeWorkerWorktreeRecordV1): void {
    for (const key of ["authorityDigest", "workspaceId", "sessionId", "workerId", "repositoryRoot", "commonDir", "path", "gitWorktreeId", "baseOid", "privateRef", "lockReasonDigest", "generation"] as const) {
      if (actual[key] !== expected[key]) throw new RuntimeFailure("conflict", `Worker worktree ${key} conflicts with durable ownership`);
    }
  }

  async #verifyGitRecord(target: string, expectedOid: string | undefined, lockReason: string, signal?: AbortSignal): Promise<string> {
    const listed = await this.#git.run(this.#repositoryRoot, ["worktree", "list", "--porcelain", "-z"], signal);
    const item = parseWorktreePorcelainZ(listed.stdout).find((candidate) => path.resolve(candidate.path) === path.resolve(target));
    if (item === undefined || item.head === undefined || (expectedOid !== undefined && item.head !== expectedOid) || !item.detached || item.lockReason !== lockReason) {
      throw new RuntimeFailure("conflict", "Git worktree metadata does not match durable ownership");
    }
    return item.head;
  }

  async #cleanDigest(target: string, signal?: AbortSignal): Promise<string> {
    const status = await this.#git.run(target, ["status", "--porcelain=v1", "--untracked-files=all"], signal);
    if (status.stdout.length > 0) throw new RuntimeFailure("conflict", "Worker worktree is dirty and was retained");
    return sha256(status.stdout);
  }
}
