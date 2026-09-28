import fs from "node:fs";
import path from "node:path";

import {
  SessionController,
  branchId,
  revision,
  sessionEventId,
  sessionId,
  type SessionEvent,
  type SessionId,
  type SessionLoadResult,
  type SessionStore,
} from "@octocodeai/agent-core";
import {
  NativeRustSessionIndex,
  NativeRustSessionStore,
} from "../../../octocode-agent/src/native-rust-data-ports.js";
import { NativeRustCoreClient } from "../../../octocode-agent/src/native-rust-core.js";

import type { ProductionScenarioProbe } from "../../src/production-host-adapters.js";

const PROBE_SESSION_NAME = "production-probe-session";

function rustBinaryPath(): string {
  const binary = process.platform === "win32"
    ? "octocode-agent-core-rust.exe"
    : "octocode-agent-core-rust";
  const candidate = path.resolve(
    import.meta.dirname,
    "../../../octocode-agent-core-rust/target/debug",
    binary,
  );
  if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile())
    throw new Error(
      `Native Rust core is missing; build the production service first: ${candidate}`,
    );
  return candidate;
}

function client(root: string, database: string): NativeRustCoreClient {
  fs.mkdirSync(root, { recursive: true });
  return new NativeRustCoreClient({
    binaryPath: rustBinaryPath(),
    dbPath: path.join(root, database),
  });
}

async function append(
  store: SessionStore,
  id: SessionId,
  storedEvent: SessionEvent["event"],
  visibility: SessionEvent["visibility"] = "internal",
): Promise<void> {
  const loaded = await store.load(id);
  const sequence = Number(loaded.projection.revision) + 1;
  const event: SessionEvent = {
    schemaVersion: 1,
    sessionId: id,
    eventId: sessionEventId(`${id}:production-conformance:${sequence}`),
    revision: revision(String(sequence)),
    sequence,
    timestamp: 1_000 + sequence,
    visibility,
    event: storedEvent,
  };
  await store.append(id, loaded.projection.revision, [event]);
}

function descriptor(event: SessionEvent) {
  return {
    sequence: event.sequence,
    revision: String(event.revision),
    visibility: event.visibility,
    type: event.event.type,
    ...(event.event.type === "custom.appended"
      ? { kind: event.event.kind }
      : {}),
  };
}

function semanticProjection(loaded: SessionLoadResult): unknown {
  const projection = loaded.projection;
  return {
    sessionId: String(projection.sessionId),
    revision: String(projection.revision),
    name: projection.name,
    transcript: projection.transcript.map(({ role, content }) => ({
      role,
      content,
    })),
    modelContext: projection.modelContext.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.role === "assistant" && message.toolCalls !== undefined
        ? { toolCalls: message.toolCalls }
        : {}),
      ...(message.role === "tool" ? { toolCallId: message.toolCallId } : {}),
    })),
    customEntries: projection.customEntries.map(({ kind, value }) => ({
      kind,
      value,
    })),
    branches: projection.branches,
    selectedBranch: projection.selectedBranch,
    compaction: projection.compaction,
    compactionAttempt: projection.compactionAttempt,
    artifacts: projection.artifacts,
  };
}

async function seedPersistenceSession(
  store: NativeRustSessionStore,
  id: SessionId,
  cwd: string,
): Promise<SessionLoadResult> {
  const controller = new SessionController(store, () => 1_000);
  await controller.create(id, "restart-probe");
  await append(store, id, { type: "custom.appended", kind: "session.cwd", value: cwd });
  await controller.name(PROBE_SESSION_NAME);
  await append(store, id, { type: "message.appended", role: "user", content: "persist me" }, "model");
  await append(store, id, { type: "message.appended", role: "assistant", content: "persisted response" }, "model");
  await append(store, id, { type: "custom.appended", kind: "production-probe", value: { stable: true } });
  await append(store, id, { type: "branch.created", branchId: branchId("restart-branch") });
  await append(store, id, { type: "branch.selected", branchId: branchId("restart-branch") });
  return store.load(id);
}

/**
 * Exercises the production SessionController over the native Rust session and
 * navigation ports. Parent navigation is the native conversation-tree rewind
 * boundary; the probe never substitutes a separate file-checkpoint feature.
 */
export function createNativeSessionLifecycleProbe(
  root: string,
): ProductionScenarioProbe {
  return async ({ scenario, signal }) => {
    if (scenario.id !== "session-lifecycle")
      throw new Error(`Unexpected native session scenario: ${scenario.id}`);
    signal.throwIfAborted();
    const native = client(root, "session-lifecycle.sqlite3");
    let stopped = false;
    try {
      await native.health(signal);
      const store = new NativeRustSessionStore(native);
      const index = new NativeRustSessionIndex(native);
      const controller = new SessionController(store, () => 1_000);
      const parent = sessionId("production-session-parent");
      const child = sessionId("production-session-child");

      await controller.create(parent);
      await append(store, parent, {
        type: "custom.appended",
        kind: "session.cwd",
        value: root,
      });
      const named = await controller.name(PROBE_SESSION_NAME);
      const exported = await controller.export();
      await controller.fork(parent, child);
      const resumed = await controller.resume(child);
      const sessions = await index.list(root);
      const rewindTarget = await index.resolve(child, "parent", root);
      if (rewindTarget === null)
        throw new Error("Native durable session tree has no parent rewind target");
      await controller.resume(rewindTarget);
      signal.throwIfAborted();

      await native.close();
      stopped = true;
      const roots = sessions.filter(
        ({ parentSessionId }) => parentSessionId === undefined,
      );
      return {
        source: "native-production-composition",
        events: [
          {
            kind: "session.lifecycle",
            data: {
              named: named.name,
              treeRoots: roots.length,
              navigated: rewindTarget === parent,
              forked: sessions.some(({ sessionId: id }) => id === child),
              resumed: resumed.sessionId === child,
              exported: exported.events.length > 0,
              stopped,
            },
          },
        ],
        effects: [],
        observations: [
          {
            kind: "session.durable-lifecycle",
            data: {
              sessionCount: sessions.length,
              rootCount: roots.length,
              sessions: sessions.map((entry) => ({
                sessionId: String(entry.sessionId),
                revision: String(entry.revision),
                parentSessionId:
                  entry.parentSessionId === undefined
                    ? null
                    : String(entry.parentSessionId),
              })),
            },
          },
        ],
      };
    } finally {
      if (!stopped) await native.close().catch(() => undefined);
    }
  };
}

/**
 * Commits through one Rust process and reloads through a distinct process. The
 * semantic projection is parity evidence; the complete ordered descriptor list
 * remains a lossless host observation and is never normalized to a fixed count.
 */
export function createNativePersistenceRestartProbe(
  root: string,
): ProductionScenarioProbe {
  return async ({ scenario, signal }) => {
    if (scenario.id !== "persistence-restart")
      throw new Error(`Unexpected native persistence scenario: ${scenario.id}`);
    signal.throwIfAborted();
    const database = "persistence-restart.sqlite3";
    const id = sessionId("production-persistence-restart");

    const writer = client(root, database);
    let before: SessionLoadResult;
    try {
      await writer.health(signal);
      before = await seedPersistenceSession(
        new NativeRustSessionStore(writer),
        id,
        root,
      );
    } finally {
      await writer.close();
    }

    signal.throwIfAborted();
    const reader = client(root, database);
    let after: SessionLoadResult;
    try {
      await reader.health(signal);
      after = await new NativeRustSessionStore(reader).load(id);
    } finally {
      await reader.close();
    }

    const beforeDescriptors = before.events.map(descriptor);
    const afterDescriptors = after.events.map(descriptor);
    const deterministicProjection =
      JSON.stringify(semanticProjection(before)) ===
      JSON.stringify(semanticProjection(after));
    const descriptorsPreserved =
      JSON.stringify(beforeDescriptors) === JSON.stringify(afterDescriptors);

    return {
      source: "native-production-composition",
      events: [
        {
          kind: "persistence.restarted",
          data: { deterministicProjection },
        },
      ],
      effects: [],
      observations: [
        {
          kind: "persistence.durable-entry-count",
          data: { count: after.events.length },
        },
        {
          kind: "persistence.durable-lifecycle-descriptors",
          data: {
            count: afterDescriptors.length,
            descriptors: afterDescriptors,
            preservedAcrossRestart: descriptorsPreserved,
          },
        },
        {
          kind: "persistence.restart-processes",
          data: { count: 2 },
        },
      ],
    };
  };
}
