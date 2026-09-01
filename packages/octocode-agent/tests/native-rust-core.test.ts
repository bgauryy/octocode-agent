import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  NativeRustCoreClient,
  NativeRustCoreError,
  type NativeRustCoreChild,
  type NativeRustCoreObject,
} from "../src/native-rust-core.js";

interface RequestEnvelope {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly method: string;
  readonly params: NativeRustCoreObject;
}

class FixtureChild extends EventEmitter implements NativeRustCoreChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: RequestEnvelope[] = [];
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];
  readonly stdin: Writable;
  closeOnEnd = false;
  closeOnKill: NodeJS.Signals | undefined;
  onRequest?: (request: RequestEnvelope) => void;
  #input = "";
  #didClose = false;

  constructor(stallWrites = false) {
    super();
    if (stallWrites) {
      this.stdin = new Writable({
        highWaterMark: 1,
        write: () => undefined,
      });
      return;
    }
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.#input += chunk.toString();
        for (;;) {
          const newline = this.#input.indexOf("\n");
          if (newline < 0) break;
          const line = this.#input.slice(0, newline);
          this.#input = this.#input.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line) as RequestEnvelope;
          this.requests.push(request);
          this.onRequest?.(request);
        }
        callback();
      },
    });
    this.stdin.once("finish", () => {
      if (this.closeOnEnd) this.close(0, null);
    });
  }

  respond(request: RequestEnvelope, result: unknown): void {
    this.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, id: request.id, ok: true, result })}\n`,
    );
  }

  fail(request: RequestEnvelope, code: string, message: string): void {
    this.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, id: request.id, ok: false, error: { code, message } })}\n`,
    );
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#didClose) return;
    this.#didClose = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    if (signal === this.closeOnKill) this.close(null, signal as NodeJS.Signals);
    return true;
  }
}

function bridge(
  child: FixtureChild,
  overrides: Partial<
    ConstructorParameters<typeof NativeRustCoreClient>[0]
  > = {},
): NativeRustCoreClient {
  return new NativeRustCoreClient({
    binaryPath: "/opt/octocode/octocode-data-core",
    dbPath: "/tmp/octocode-agent.sqlite3",
    spawn: (_binary, _args) => child,
    ...overrides,
  });
}

describe("native Rust data-core bridge", () => {
  const realBinary = path.resolve(
    import.meta.dirname,
    "../../octocode-agent-core-rust/target/debug/octocode-agent-core-rust",
  );

  it.skipIf(!fs.existsSync(realBinary))(
    "runs the typed persistence flows against the real Rust binary",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "octocode-rust-core-bridge-"),
      );
      try {
        const client = new NativeRustCoreClient({
          binaryPath: realBinary,
          dbPath: path.join(root, "agent.sqlite3"),
        });
        await expect(client.health()).resolves.toMatchObject({ status: "ok" });
        await expect(
          client.sessionLoad({ sessionId: "missing" }),
        ).resolves.toBeNull();
        await expect(
          client.sessionAppend({
            sessionId: "session",
            expectedRevision: "0",
            events: [{ type: "created" }],
            index: { cwd: "/workspace", parentSessionId: null, updatedAt: 1 },
          }),
        ).resolves.toMatchObject({ revision: "1" });
        await expect(
          client.sessionLoad({ sessionId: "session" }),
        ).resolves.toMatchObject({
          revision: "1",
          events: [{ type: "created" }],
        });
        await expect(
          client.sessionList({ cwd: "/workspace", limit: 10 }),
        ).resolves.toEqual([
          expect.objectContaining({
            sessionId: "session",
            revision: "1",
            cwd: "/workspace",
          }),
        ]);
        const largeEvents = Array.from({ length: 6 }, (_, index) => ({
          index,
          text: "x".repeat(220_000),
        }));
        for (const [index, event] of largeEvents.entries()) {
          await expect(
            client.sessionAppend({
              sessionId: "paged-session",
              expectedRevision: String(index),
              events: [event],
              index: null,
            }),
          ).resolves.toMatchObject({ revision: String(index + 1) });
        }
        const paged = await client.sessionLoad({ sessionId: "paged-session" });
        expect(paged).toMatchObject({
          sessionId: "paged-session",
          revision: "6",
        });
        expect(paged?.["events"]).toEqual(largeEvents);
        await expect(
          client.effectBegin({
            sessionId: "session",
            key: "effect",
            receipt: { operation: "write" },
          }),
        ).resolves.toBe("acquired");
        await expect(
          client.effectGet({ sessionId: "session", key: "effect" }),
        ).resolves.toMatchObject({
          key: "effect",
          state: "started",
          receipt: { operation: "write" },
          updatedAt: expect.any(Number),
        });
        await expect(
          client.effectSettle({
            sessionId: "session",
            key: "effect",
            state: "committed",
          }),
        ).resolves.toBe("committed");
        await expect(client.settingsGet("global")).resolves.toMatchObject({
          revision: "0",
          values: {},
        });
        await expect(
          client.settingsCompareAndSet("global", "0", { theme: "dark" }),
        ).resolves.toMatchObject({ revision: "1" });
        await expect(
          client.communicationEnqueue({
            channel: "messages",
            messageId: "one",
            availableAt: 10,
            payload: { text: "hello" },
          }),
        ).resolves.toMatchObject({ enqueued: true });
        const communicationClaims = await client.communicationClaim({
          channel: "messages",
          consumerId: "agent",
          now: 10,
          leaseMs: 100,
          limit: 1,
        });
        expect(communicationClaims).toEqual([
          expect.objectContaining({
            messageId: "one",
            payload: { text: "hello" },
            leaseGeneration: expect.any(Number),
          }),
        ]);
        await expect(
          client.communicationAck({
            channel: "messages",
            messageId: "one",
            consumerId: "agent",
            leaseGeneration: communicationClaims[0]!.leaseGeneration,
          }),
        ).resolves.toMatchObject({ acknowledged: true });
        await expect(
          client.lifecycleAppend("workers", "spawn", { type: "spawn" }),
        ).resolves.toMatchObject({ sequence: 1, appended: true });
        await expect(client.lifecycleList("workers", 0, 10)).resolves.toEqual([
          expect.objectContaining({
            eventId: "spawn",
            event: { type: "spawn" },
          }),
        ]);
        const definition = {
          schemaVersion: 1,
          id: "status",
          revision: 0,
          state: "active",
          schedule: { kind: "once", at: 100 },
          misfirePolicy: "run-once",
          retryPolicy: { maxAttempts: 2, backoffMs: 1_000 },
          action: {
            name: "awareness.status",
            version: 1,
            payload: { workspace: "/workspace" },
          },
          createdAt: 10,
          updatedAt: 10,
        } as const;
        await expect(client.automationPut(definition)).resolves.toEqual(
          definition,
        );
        await expect(
          client.automationList({
            limit: 100,
            states: ["active", "paused", "cancelled"],
          }),
        ).resolves.toEqual([definition]);
        const claims = await client.automationClaim({
          ownerId: "native-agent",
          now: 100,
          leaseMs: 100,
          limit: 1,
          candidates: [{ automationId: "status", scheduledFor: 100 }],
        });
        expect(claims).toHaveLength(1);
        const claim = claims[0]!;
        await expect(
          client.automationHeartbeat({
            runId: String(claim["runId"]),
            ownerId: "native-agent",
            fencingToken: Number(claim["fencingToken"]),
            now: 101,
            leaseMs: 100,
          }),
        ).resolves.toMatchObject({ leaseExpiresAt: 201 });
        await expect(
          client.automationComplete({
            runId: String(claim["runId"]),
            ownerId: "native-agent",
            fencingToken: Number(claim["fencingToken"]),
            outcome: {
              state: "succeeded",
              completedAt: 102,
              result: { ok: true },
            },
          }),
        ).resolves.toMatchObject({
          state: "succeeded",
          outcome: { state: "succeeded", result: { ok: true } },
        });
        await client.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("spawns with an absolute database path and correlates concurrent responses out of order", async () => {
    const child = new FixtureChild();
    let spawn: { binary: string; args: readonly string[] } | undefined;
    const client = new NativeRustCoreClient({
      binaryPath: "/opt/octocode/data-core",
      dbPath: "/tmp/agent.sqlite3",
      spawn: (binary, args) => {
        spawn = { binary, args };
        return child;
      },
    });
    child.onRequest = () => {
      if (child.requests.length !== 2) return;
      child.respond(child.requests[1]!, {
        sessionId: "second",
        revision: "2",
        afterSequence: null,
        events: [
          { sequence: "1", event: { n: 1 } },
          { sequence: "2", event: { n: 2 } },
        ],
        nextCursor: null,
        done: true,
      });
      child.respond(child.requests[0]!, { status: "ok" });
    };

    const health = client.health();
    const loaded = client.sessionLoad({ sessionId: "second" });
    await expect(Promise.all([health, loaded])).resolves.toEqual([
      { status: "ok" },
      { sessionId: "second", revision: "2", events: [{ n: 1 }, { n: 2 }] },
    ]);
    expect(spawn).toEqual({
      binary: "/opt/octocode/data-core",
      args: ["--db", "/tmp/agent.sqlite3"],
    });
    child.closeOnEnd = true;
    await client.close();
  });

  it("reassembles strictly ordered bounded session pages", async () => {
    const child = new FixtureChild();
    const client = bridge(child);
    child.onRequest = (request) => {
      if (child.requests.length === 1) {
        child.respond(request, {
          sessionId: "session",
          revision: "3",
          afterSequence: null,
          events: [
            { sequence: "1", event: { n: 1 } },
            { sequence: "2", event: { n: 2 } },
          ],
          nextCursor: "2",
          done: false,
        });
      } else {
        child.respond(request, {
          sessionId: "session",
          revision: "3",
          afterSequence: "2",
          events: [{ sequence: "3", event: { n: 3 } }],
          nextCursor: null,
          done: true,
        });
      }
    };

    await expect(client.sessionLoad({ sessionId: "session" })).resolves.toEqual(
      {
        sessionId: "session",
        revision: "3",
        events: [{ n: 1 }, { n: 2 }, { n: 3 }],
      },
    );
    expect(child.requests.map(({ method }) => method)).toEqual([
      "session.loadPage",
      "session.loadPage",
    ]);
    expect(child.requests[0]?.params).toMatchObject({
      sessionId: "session",
      afterSequence: null,
      expectedRevision: null,
      maxEvents: expect.any(Number),
      maxBytes: expect.any(Number),
    });
    expect(child.requests[1]?.params).toMatchObject({
      afterSequence: "2",
      expectedRevision: "3",
    });
    child.closeOnEnd = true;
    await client.close();
  });

  it("fails closed on noncontiguous session page cursors", async () => {
    const child = new FixtureChild();
    const client = bridge(child);
    child.onRequest = (request) =>
      child.respond(request, {
        sessionId: "session",
        revision: "2",
        afterSequence: null,
        events: [{ sequence: "2", event: { n: 2 } }],
        nextCursor: null,
        done: true,
      });

    await expect(
      client.sessionLoad({ sessionId: "session" }),
    ).rejects.toMatchObject({ category: "protocol" });
    child.closeOnEnd = true;
    await client.close();
  });

  it("projects every typed operation onto its exact method and parameters", async () => {
    const child = new FixtureChild();
    const client = bridge(child);
    child.onRequest = (request) => {
      const result =
        request.method === "session.list"
          ? []
          : request.method === "session.loadPage"
            ? {
                sessionId: request.params["sessionId"],
                revision: "0",
                afterSequence: request.params["afterSequence"],
                events: [],
                nextCursor: null,
                done: true,
              }
            : request.method === "communication.claim"
              ? [
                  {
                    messageId: "m",
                    payload: { text: "hello" },
                    availableAt: 10,
                    leaseUntil: 70,
                    leaseGeneration: 1,
                  },
                ]
              : request.method.startsWith("session.") ||
                  request.method.startsWith("settings.")
                ? {
                    method: request.method,
                    params: request.params,
                    revision: "2",
                  }
                : { method: request.method, params: request.params };
      child.respond(request, result);
    };
    const event = { type: "test" } as const;

    await client.sessionAppend({
      sessionId: "s",
      expectedRevision: "1",
      events: [event],
      index: null,
    });
    await client.sessionLoad({ sessionId: "s" });
    await client.sessionList({ cwd: "/workspace", limit: 10 });
    await client.effectBegin({
      sessionId: "s",
      key: "e",
      receipt: { operation: "write" },
    });
    await client.effectGet({ sessionId: "s", key: "e" });
    await client.effectSettle({ sessionId: "s", key: "e", state: "committed" });
    await client.communicationEnqueue({
      channel: "q",
      messageId: "m",
      availableAt: 10,
      payload: { text: "hello" },
    });
    await client.communicationClaim({
      channel: "q",
      consumerId: "c",
      now: 20,
      limit: 2,
      leaseMs: 50,
    });
    await client.communicationAck({
      channel: "q",
      messageId: "m",
      consumerId: "c",
      leaseGeneration: 1,
    });
    await client.communicationRelease({
      channel: "q",
      messageId: "m",
      consumerId: "c",
      leaseGeneration: 1,
    });
    await client.settingsGet("global");
    await client.settingsCompareAndSet("global", "1", { theme: "dark" });
    await client.lifecycleAppend("workers", "event-1", event);
    await client.lifecycleList("workers", 4, 10);

    expect(child.requests.map(({ method }) => method)).toEqual([
      "session.append",
      "session.loadPage",
      "session.list",
      "effect.begin",
      "effect.get",
      "effect.settle",
      "communication.enqueue",
      "communication.claim",
      "communication.ack",
      "communication.release",
      "settings.get",
      "settings.compareAndSet",
      "lifecycle.append",
      "lifecycle.list",
    ]);
    expect(child.requests.at(-1)?.params).toEqual({
      streamId: "workers",
      afterSequence: 4,
      limit: 10,
    });
    expect(child.requests[0]?.params).toMatchObject({ expectedRevision: "1" });
    expect(child.requests[2]?.params).toEqual({ cwd: "/workspace", limit: 10 });
    expect(child.requests[6]?.params).toEqual({
      channel: "q",
      messageId: "m",
      availableAt: 10,
      payload: { text: "hello" },
    });
    expect(child.requests[7]?.params).toEqual({
      channel: "q",
      consumerId: "c",
      now: 20,
      limit: 2,
      leaseMs: 50,
    });
    expect(child.requests[11]?.params).toMatchObject({ expectedRevision: "1" });
    child.closeOnEnd = true;
    await client.close();
  });

  it("projects the complete automation RPC surface and validates each typed result", async () => {
    const child = new FixtureChild();
    const client = bridge(child);
    const definition = {
      schemaVersion: 1,
      id: "status",
      revision: 0,
      state: "active",
      schedule: { kind: "once", at: 100 },
      misfirePolicy: "run-once",
      retryPolicy: { maxAttempts: 2, backoffMs: 1_000 },
      action: { name: "awareness.status", version: 1, payload: {} },
      createdAt: 10,
      updatedAt: 10,
    } as const;
    const claim = {
      schemaVersion: 1,
      runId: "run-1",
      automationId: "status",
      scheduledFor: 100,
      attempt: 1,
      state: "claimed",
      ownerId: "native-agent",
      leaseExpiresAt: 200,
      fencingToken: 7,
    } as const;
    child.onRequest = (request) => {
      if (
        request.method === "automation.put" ||
        request.method === "automation.cancel"
      )
        child.respond(
          request,
          request.method === "automation.put"
            ? definition
            : {
                ...definition,
                revision: 1,
                state: "cancelled",
                updatedAt: 20,
              },
        );
      else if (request.method === "automation.list")
        child.respond(request, [definition]);
      else if (request.method === "automation.claim")
        child.respond(request, [claim]);
      else if (request.method === "automation.heartbeat")
        child.respond(request, claim);
      else {
        const state = request.method.replace("automation.", "");
        const terminal =
          state === "complete"
            ? "succeeded"
            : state === "fail"
              ? "failed"
              : state;
        child.respond(request, {
          schemaVersion: 1,
          runId: claim.runId,
          automationId: claim.automationId,
          scheduledFor: claim.scheduledFor,
          attempt: claim.attempt,
          state: terminal,
          outcome: request.params["outcome"],
        });
      }
    };

    await client.automationPut(definition);
    await client.automationList({ limit: 100, states: ["active"] });
    await client.automationCancel({
      id: "status",
      expectedRevision: 0,
      cancelledAt: 20,
    });
    await client.automationClaim({
      ownerId: "native-agent",
      now: 100,
      leaseMs: 100,
      limit: 1,
      candidates: [{ automationId: "status", scheduledFor: 100 }],
    });
    await client.automationHeartbeat({
      runId: "run-1",
      ownerId: "native-agent",
      fencingToken: 7,
      now: 101,
      leaseMs: 100,
    });
    await client.automationComplete({
      runId: "run-1",
      ownerId: "native-agent",
      fencingToken: 7,
      outcome: { state: "succeeded", completedAt: 102 },
    });
    await client.automationFail({
      runId: "run-1",
      ownerId: "native-agent",
      fencingToken: 7,
      outcome: {
        state: "failed",
        completedAt: 102,
        error: { code: "failed", message: "failed", retryable: false },
      },
    });
    await client.automationUncertain({
      runId: "run-1",
      ownerId: "native-agent",
      fencingToken: 7,
      outcome: { state: "uncertain", completedAt: 102, reason: "lost" },
    });

    expect(child.requests.slice(-8).map(({ method }) => method)).toEqual([
      "automation.put",
      "automation.list",
      "automation.cancel",
      "automation.claim",
      "automation.heartbeat",
      "automation.complete",
      "automation.fail",
      "automation.uncertain",
    ]);
    expect(child.requests.at(-5)?.params).toEqual({
      ownerId: "native-agent",
      now: 100,
      leaseMs: 100,
      limit: 1,
      candidates: [{ automationId: "status", scheduledFor: 100 }],
    });
    child.closeOnEnd = true;
    await client.close();
  });

  it.each([
    [
      "definition",
      "automation.put",
      { schemaVersion: 1, id: "missing-fields" },
    ],
    [
      "claims",
      "automation.claim",
      [{ schemaVersion: 1, fencingToken: "string" }],
    ],
    [
      "outcome",
      "automation.complete",
      {
        schemaVersion: 1,
        runId: "run",
        automationId: "status",
        scheduledFor: 1,
        attempt: 1,
        state: "succeeded",
        outcome: { state: "failed", completedAt: 2 },
      },
    ],
  ])(
    "fails closed on malformed automation %s responses",
    async (_label, method, result) => {
      const child = new FixtureChild();
      const client = bridge(child);
      child.onRequest = (request) => child.respond(request, result);
      const definition = {
        schemaVersion: 1,
        id: "status",
        revision: 0,
        state: "active",
        schedule: { kind: "once", at: 1 },
        misfirePolicy: "skip",
        retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        action: { name: "status", version: 1, payload: {} },
        createdAt: 1,
        updatedAt: 1,
      } as const;
      const operation =
        method === "automation.put"
          ? client.automationPut(definition)
          : method === "automation.claim"
            ? client.automationClaim({
                ownerId: "owner",
                now: 1,
                leaseMs: 1,
                limit: 1,
                candidates: [{ automationId: "status", scheduledFor: 1 }],
              })
            : client.automationComplete({
                runId: "run",
                ownerId: "owner",
                fencingToken: 1,
                outcome: { state: "succeeded", completedAt: 2 },
              });
      await expect(operation).rejects.toMatchObject({ category: "protocol" });
      child.closeOnEnd = true;
      await client.close();
    },
  );

  it("honors automation cancellation before writing a request", async () => {
    const child = new FixtureChild();
    const client = bridge(child);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.automationList(
        { limit: 100, states: ["active", "paused", "cancelled"] },
        controller.signal,
      ),
    ).rejects.toMatchObject({ category: "cancelled" });
    expect(child.requests).toEqual([]);
    child.closeOnEnd = true;
    await client.close();
  });

  it("fails closed on communication claims without a valid lease generation", async () => {
    const child = new FixtureChild();
    const client = bridge(child);
    child.onRequest = (request) =>
      child.respond(request, [
        {
          messageId: "message",
          payload: {},
          availableAt: 1,
          leaseUntil: 2,
        },
      ]);

    await expect(
      client.communicationClaim({
        channel: "messages",
        consumerId: "consumer",
        now: 1,
        leaseMs: 1,
        limit: 1,
      }),
    ).rejects.toMatchObject({ category: "protocol" });
    child.closeOnEnd = true;
    await client.close();
  });

  it("rejects invalid communication receipts before writing them", async () => {
    const child = new FixtureChild();
    const client = bridge(child);

    await expect(
      client.communicationAck({
        channel: "messages",
        messageId: "message",
        consumerId: "consumer",
        leaseGeneration: 0,
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(child.requests).toEqual([]);
    child.closeOnEnd = true;
    await client.close();
  });

  it.each([
    ["invalid JSON", "{not-json}\n"],
    ["malformed envelope", '{"schemaVersion":1,"id":"x","ok":true}\n'],
    [
      "unknown response ID",
      '{"schemaVersion":1,"id":"other","ok":true,"result":{}}\n',
    ],
  ])("fails closed on %s", async (_label, output) => {
    const child = new FixtureChild();
    const client = bridge(child);
    child.onRequest = () => child.stdout.write(output);
    await expect(client.health()).rejects.toMatchObject({
      category: "protocol",
    });
    expect(child.kills).toContain("SIGKILL");
  });

  it("rejects duplicate responses as a protocol failure", async () => {
    const child = new FixtureChild();
    const client = bridge(child);
    child.onRequest = (request) => {
      child.respond(request, { status: "ok" });
      child.respond(request, { status: "duplicate" });
    };
    await expect(client.health()).resolves.toEqual({ status: "ok" });
    await expect(client.health()).rejects.toMatchObject({ category: "closed" });
    expect(child.kills).toContain("SIGKILL");
  });

  it("rejects pending calls on process error and exit without exposing process details", async () => {
    const child = new FixtureChild();
    const client = bridge(child);
    const pending = client.health();
    await Promise.resolve();
    child.emit("error", new Error("secret /private/db/path token=abc"));
    const failure = await pending.catch(
      (error: unknown) => error as NativeRustCoreError,
    );
    expect(failure).toMatchObject({ category: "process" });
    expect(failure.message).not.toMatch(/secret|private|token/u);

    const exitedChild = new FixtureChild();
    const exited = bridge(exitedChild);
    const waiting = exited.sessionLoad({ sessionId: "s" });
    await Promise.resolve();
    exitedChild.close(70, null);
    await expect(waiting).rejects.toMatchObject({
      category: "process",
      message: "Native data core process exited",
    });
  });

  it("honors cancellation before writing a request", async () => {
    const child = new FixtureChild();
    const client = bridge(child);
    const controller = new AbortController();
    controller.abort("do not write");
    await expect(client.health(controller.signal)).rejects.toMatchObject({
      category: "cancelled",
    });
    expect(child.requests).toEqual([]);
    child.closeOnEnd = true;
    await client.close();
  });

  it("rejects cancellation after dispatch and safely consumes the late response", async () => {
    const child = new FixtureChild();
    const client = bridge(child);
    const controller = new AbortController();
    const pending = client.health(controller.signal);
    await Promise.resolve();
    const request = child.requests[0]!;

    controller.abort("stop waiting");
    child.respond(request, { status: "late" });
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });

    child.onRequest = (next) => child.respond(next, { status: "ok" });
    await expect(client.health()).resolves.toEqual({ status: "ok" });
    expect(child.kills).toEqual([]);
    child.closeOnEnd = true;
    await client.close();
  });

  it("enforces request and response line byte limits", async () => {
    const requestChild = new FixtureChild();
    const requestClient = bridge(requestChild, { maxRequestBytes: 100 });
    await expect(
      requestClient.communicationEnqueue({
        channel: "q",
        messageId: "m",
        availableAt: 0,
        payload: { text: "x".repeat(200) },
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(requestChild.requests).toEqual([]);
    requestChild.closeOnEnd = true;
    await requestClient.close();

    const responseChild = new FixtureChild();
    const responseClient = bridge(responseChild, { maxResponseLineBytes: 64 });
    responseChild.onRequest = (request) =>
      responseChild.respond(request, { text: "x".repeat(100) });
    await expect(responseClient.health()).rejects.toMatchObject({
      category: "protocol",
    });
    expect(responseChild.kills).toContain("SIGKILL");
  });

  it("uses canonical decimal-string session revisions and rejects unsafe wire revisions", async () => {
    const child = new FixtureChild();
    const client = bridge(child);
    child.onRequest = (request) =>
      child.respond(request, { revision: "9223372036854775807" });
    await expect(
      client.sessionAppend({
        sessionId: "s",
        expectedRevision: "0",
        events: [],
        index: null,
      }),
    ).resolves.toMatchObject({ revision: "9223372036854775807" });
    expect(child.requests[0]?.params["expectedRevision"]).toBe("0");
    await expect(
      client.sessionAppend({
        sessionId: "s",
        expectedRevision: "01",
        events: [],
        index: null,
      }),
    ).rejects.toMatchObject({ category: "validation" });

    const malformed = new FixtureChild();
    const malformedClient = bridge(malformed);
    malformed.onRequest = (request) =>
      malformed.respond(request, { revision: 9_007_199_254_740_992 });
    await expect(
      malformedClient.sessionLoad({ sessionId: "s" }),
    ).rejects.toThrow(/session page/u);
    child.closeOnEnd = true;
    malformed.closeOnEnd = true;
    await Promise.all([client.close(), malformedClient.close()]);
  });

  it("uses EOF for graceful close and escalates TERM to KILL when the child does not stop", async () => {
    const gracefulChild = new FixtureChild();
    gracefulChild.closeOnEnd = true;
    const graceful = bridge(gracefulChild);
    await graceful.close();
    expect(gracefulChild.kills).toEqual([]);

    const stuckChild = new FixtureChild();
    stuckChild.closeOnKill = "SIGKILL";
    const stuck = bridge(stuckChild, { closeGraceMs: 5, terminateGraceMs: 5 });
    await stuck.close();
    expect(stuckChild.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails bounded close when KILL is not observed as a process exit", async () => {
    const child = new FixtureChild();
    const client = bridge(child, { closeGraceMs: 5, terminateGraceMs: 5 });

    await expect(client.close()).rejects.toMatchObject({ category: "process" });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("bounds close while an admitted write remains backpressured", async () => {
    const child = new FixtureChild(true);
    child.closeOnKill = "SIGKILL";
    const client = bridge(child, { closeGraceMs: 5, terminateGraceMs: 5 });
    const pending = client.health();
    await Promise.resolve();

    await client.close();
    await expect(pending).rejects.toMatchObject({ category: "process" });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("rejects relative database paths before spawning", () => {
    expect(
      () =>
        new NativeRustCoreClient({
          binaryPath: "/bin/core",
          dbPath: "relative.sqlite3",
        }),
    ).toThrow(/absolute/u);
  });
});
