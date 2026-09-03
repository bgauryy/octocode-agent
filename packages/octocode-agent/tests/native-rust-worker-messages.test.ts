import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerAuthorityV1 } from "@octocodeai/agent-core";
import {
  NativeRustWorkerMessageJournal,
  nativeWorkerAuthorityDigest,
  type NativeWorkerCommunicationCore,
} from "../src/native-rust-worker-messages.js";
import {
  NativeRustCoreClient,
  NativeRustCoreError,
  type NativeRustCoreObject,
  type NativeRustWorkerMailboxClaimResult,
} from "../src/native-rust-core.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function coreFixture(overrides: Partial<NativeWorkerCommunicationCore> = {}) {
  let payload: NativeRustCoreObject | undefined;
  let messageId = "request-1";
  const core: NativeWorkerCommunicationCore = {
    workerMailboxOpen: vi.fn(async (input) => ({
      schemaVersion: 1,
      mailboxGeneration: input.mailboxGeneration,
      nextSequence: 1,
      sealed: false,
      idempotent: false,
    } as const)),
    workerMailboxEnqueue: vi.fn(async (input) => {
      payload = input.payload;
      messageId = input.messageId;
      return {
        schemaVersion: 1,
        messageId,
        sequence: 1,
        state: "pending",
        idempotent: false,
        pressure: { messages: 1, bytes: 100, highWater: false },
      } as const;
    }),
    workerMailboxClaim: vi.fn(async (input) => [
      {
        schemaVersion: 1,
        messageId,
        sequence: 1,
        sender: "parent-1",
        recipient: "worker-1",
        commandKind: "input.follow-up",
        lane: "data",
        payload: payload ?? {},
        payloadDigest: "payload-digest",
        state: "leased",
        leaseOwner: input.consumerId,
        leaseGeneration: 1,
        leaseExpiresAt: input.now + input.leaseMs,
      },
    ] as const),
    workerMailboxExtend: vi.fn(async (input) => ({ schemaVersion: 1, messageId: input.messageId, state: "leased", idempotent: false, leaseGeneration: input.leaseGeneration } as const)),
    workerMailboxRelease: vi.fn(async (input) => ({ schemaVersion: 1, messageId: input.messageId, state: "pending", idempotent: false } as const)),
    workerMailboxMarkWritten: vi.fn(async (input) => ({ schemaVersion: 1, messageId: input.messageId, state: "written", idempotent: false, leaseGeneration: input.leaseGeneration } as const)),
    workerMailboxAck: vi.fn(async (input) => ({ schemaVersion: 1, messageId: input.messageId, state: "acknowledged", idempotent: false } as const)),
    workerMailboxTerminalize: vi.fn(async (input) => ({ schemaVersion: 1, messageId: input.messageId, state: input.state, idempotent: false } as const)),
    workerMailboxList: vi.fn(async () => []),
    communicationAbandonPrefix: vi.fn(async () => []),
    ...overrides,
  };
  return core;
}

const authority = {
  schemaVersion: 1,
  workerId: "worker-1",
  correlationId: "correlation-1",
  rootAgentId: "parent-1",
  parentSessionId: "session-1",
  workspaceId: "workspace-1",
  workspaceGeneration: 1,
  trustRevision: "trust-1",
  permissionMode: "default",
  capabilityDigest: "capability-1",
  effectAdmissionId: "effect-1",
  ownershipGeneration: 1,
} as unknown as WorkerAuthorityV1;

const input = {
  workerId: "worker-1",
  correlationId: "correlation-1",
  sessionId: "session-1",
  parentAgentId: "parent-1",
  requestId: "request-1",
  command: {
    type: "input.follow-up" as const,
    text: "inspect the failing flow",
  },
  authority,
  mailboxGeneration: 1,
};

describe("native Rust worker message journal", () => {
  const releaseBinary = path.resolve(
    import.meta.dirname,
    "../../octocode-agent-core-rust/target/release/octocode-agent-core-rust",
  );
  const debugBinary = path.resolve(
    import.meta.dirname,
    "../../octocode-agent-core-rust/target/debug/octocode-agent-core-rust",
  );
  const binary = fs.existsSync(debugBinary) ? debugBinary : releaseBinary;

  it("stages a validated AI SDK UIMessage and acknowledges its Rust lease", async () => {
    const core = coreFixture();
    const journal = new NativeRustWorkerMessageJournal(core, {
      now: () => 1_000,
      consumerId: "process-parent-1",
      leaseMs: 30_000,
    });

    const lease = await journal.stage(input);

    expect(lease.message).toEqual({
      id: "request-1",
      role: "user",
      metadata: {
        schemaVersion: 1,
        kind: "octocode.worker.input",
        workerId: "worker-1",
        correlationId: "correlation-1",
        sessionId: "session-1",
        parentAgentId: "parent-1",
        requestId: "request-1",
        commandType: "input.follow-up",
        createdAt: 1_000,
      },
      parts: [{ type: "text", text: "inspect the failing flow" }],
    });
    expect(core.workerMailboxEnqueue).toHaveBeenCalledOnce();
    expect(core.workerMailboxClaim).toHaveBeenCalledOnce();

    await lease.markWritten();
    await lease.ack();

    expect(core.workerMailboxAck).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "request-1",
        consumerId: "process-parent-1",
        leaseGeneration: 1,
      }),
    );
    await lease.ack();
    expect(core.workerMailboxAck).toHaveBeenCalledOnce();
  });

  it("deterministically abandons stranded session messages without replaying them", async () => {
    const abandon = vi
      .fn()
      .mockResolvedValueOnce([
        {
          channel: "worker-input:session-1:worker-1:request-1",
          messageId: "request-1",
        },
        {
          channel: "worker-input:session-1:worker-2:request-2",
          messageId: "request-2",
        },
      ])
      .mockResolvedValueOnce([]);
    const core = coreFixture({ communicationAbandonPrefix: abandon });
    const journal = new NativeRustWorkerMessageJournal(core);

    await expect(journal.abandonSession("session-1")).resolves.toEqual({
      abandoned: 2,
    });
    expect(abandon).toHaveBeenNthCalledWith(1, {
      channelPrefix: "worker-input:session-1:",
      limit: 1_000,
    });
    expect(abandon).toHaveBeenCalledOnce();
    expect(core.workerMailboxClaim).not.toHaveBeenCalled();
  });

  it.each([
    [
      "input.submit",
      { type: "input.submit" as const, text: "submit text" },
      "submit text",
    ],
    [
      "input.follow-up",
      { type: "input.follow-up" as const, text: "follow-up text" },
      "follow-up text",
    ],
    [
      "input.steer",
      { type: "input.steer" as const, text: "steer text" },
      "steer text",
    ],
    [
      "input.cancel",
      { type: "input.cancel" as const, reason: "cancel reason" },
      "cancel reason",
    ],
  ])(
    "validates and stages the %s command as an AI message",
    async (commandType, command, text) => {
      const core = coreFixture();
      const journal = new NativeRustWorkerMessageJournal(core, {
        now: () => 1_500,
      });
      const lease = await journal.stage({
        ...input,
        requestId: `request-${commandType}`,
        command,
      });

      expect(lease.message.metadata.commandType).toBe(commandType);
      expect(lease.message.parts).toEqual([{ type: "text", text }]);
      await lease.markWritten();
      await lease.ack();
    },
  );

  it("stores cancellation reason as an AI text part and can release the lease", async () => {
    const core = coreFixture();
    const journal = new NativeRustWorkerMessageJournal(core, {
      now: () => 2_000,
    });
    const lease = await journal.stage({
      ...input,
      requestId: "request-cancel",
      command: { type: "input.cancel", reason: "parent stopped the task" },
    });

    expect(lease.message.parts).toEqual([
      { type: "text", text: "parent stopped the task" },
    ]);
    expect(lease.message.metadata.commandType).toBe("input.cancel");
    await lease.release();
    expect(core.workerMailboxRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "request-cancel",
        leaseGeneration: 1,
      }),
    );
  });

  it("enforces written versus pre-write terminal settlement", async () => {
    const core = coreFixture();
    const journal = new NativeRustWorkerMessageJournal(core, { now: () => 2_500 });
    const written = await journal.stage(input);
    await written.markWritten();
    await expect(written.release()).rejects.toThrow(/cannot return to pending/i);
    await written.uncertain("unknown-outcome");
    expect(core.workerMailboxTerminalize).toHaveBeenCalledWith(
      expect.objectContaining({ state: "uncertain", outcomeDigest: "unknown-outcome" }),
    );

    const pending = await journal.stage({ ...input, requestId: "request-dead" });
    await pending.deadLetter("invalid-command");
    expect(core.workerMailboxTerminalize).toHaveBeenCalledWith(
      expect.objectContaining({ state: "dead-lettered", outcomeDigest: "invalid-command" }),
    );
  });

  it("fails closed when Rust returns a malformed or mismatched AI message", async () => {
    const core = coreFixture({
      workerMailboxClaim: vi.fn(async () => [
        {
          schemaVersion: 1,
          messageId: "request-1",
          sequence: 1,
          sender: "parent-1",
          recipient: "worker-1",
          commandKind: "input.follow-up",
          lane: "data",
          payload: {
            schemaVersion: 1,
            message: { id: "request-1", role: "tool", parts: [] },
          },
          payloadDigest: "payload-digest",
          state: "leased",
          leaseOwner: "native-worker-process:1",
          leaseGeneration: 1,
          leaseExpiresAt: 31_000,
        },
      ] as unknown as NativeRustWorkerMailboxClaimResult),
    });
    const journal = new NativeRustWorkerMessageJournal(core, {
      now: () => 1_000,
    });

    await expect(journal.stage(input)).rejects.toThrow(/message envelope/i);
    expect(core.workerMailboxRelease).toHaveBeenCalledOnce();
  });

  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "fails closed when Rust returns invalid lease generation %s",
    async (leaseGeneration) => {
      const core = coreFixture({
        workerMailboxClaim: vi.fn(
          async () =>
            [
              {
                schemaVersion: 1,
                messageId: "request-1",
                sequence: 1,
                sender: "parent-1",
                recipient: "worker-1",
                commandKind: "input.follow-up",
                lane: "data",
                payload: {},
                payloadDigest: "payload-digest",
                state: "leased",
                leaseOwner: "native-worker-process:1",
                ...(leaseGeneration === undefined ? {} : { leaseGeneration }),
                leaseExpiresAt: 31_000,
              },
            ] as unknown as NativeRustWorkerMailboxClaimResult,
        ),
      });

      await expect(
        new NativeRustWorkerMessageJournal(core, { now: () => 1_000 }).stage(
          input,
        ),
      ).rejects.toThrow(/claim is malformed/i);
      expect(core.workerMailboxAck).not.toHaveBeenCalled();
      expect(core.workerMailboxRelease).not.toHaveBeenCalled();
    },
  );

  it("propagates stale lease receipt conflicts without marking the lease settled", async () => {
    const stale = new NativeRustCoreError("remote", "stale", "CONFLICT");
    const core = coreFixture({
      workerMailboxAck: vi.fn(async () => {
        throw stale;
      }),
    });
    const lease = await new NativeRustWorkerMessageJournal(core, {
      now: () => 1_000,
    }).stage(input);

    await lease.markWritten();
    await expect(lease.ack()).rejects.toBe(stale);
    await expect(lease.ack()).rejects.toBe(stale);
    expect(core.workerMailboxAck).toHaveBeenCalledTimes(2);
    expect(core.workerMailboxAck).toHaveBeenLastCalledWith(
      expect.objectContaining({ leaseGeneration: 1 }),
    );
  });

  it.skipIf(!fs.existsSync(binary))(
    "does not replay a written AI message after a real Rust process restart",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "octocode-worker-message-restart-"),
      );
      roots.push(root);
      const dbPath = path.join(root, "core.sqlite3");
      const firstClient = new NativeRustCoreClient({
        binaryPath: binary,
        dbPath,
      });
      const firstJournal = new NativeRustWorkerMessageJournal(firstClient, {
        now: () => 1_000,
        consumerId: "worker-process-before-restart",
        leaseMs: 100,
      });
      const staged = await firstJournal.stage({
        ...input,
        requestId: "request-restart",
      });
      expect(staged.message).toMatchObject({
        id: "request-restart",
        role: "user",
        metadata: {
          correlationId: "correlation-1",
          createdAt: 1_000,
        },
        parts: [{ type: "text", text: "inspect the failing flow" }],
      });
      await staged.markWritten();
      // Simulate a crash after the worker stdin write but before acknowledgement.
      await firstClient.close();

      const secondClient = new NativeRustCoreClient({
        binaryPath: binary,
        dbPath,
      });
      try {
        const secondJournal = new NativeRustWorkerMessageJournal(secondClient, {
          now: () => 1_101,
          consumerId: "worker-process-after-restart",
          leaseMs: 100,
        });
        await expect(
          secondJournal.listMailbox({ authority, mailboxGeneration: 1 }),
        ).resolves.toEqual([
          expect.objectContaining({
            messageId: "request-restart",
            sequence: 1,
            state: "written",
          }),
        ]);
        await expect(
          secondClient.workerMailboxClaim({
            authority: authority as unknown as NativeRustCoreObject,
            authorityDigest: nativeWorkerAuthorityDigest(authority),
            mailboxGeneration: 1,
            consumerId: "verification",
            now: 1_202,
            leaseMs: 1_000,
            limit: 1,
          }),
        ).resolves.toEqual([]);
      } finally {
        await secondClient.close();
      }
    },
  );

  it.skipIf(!fs.existsSync(binary))(
    "reserves the control lane when the real Rust data mailbox is backpressured",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-worker-pressure-"));
      roots.push(root);
      const client = new NativeRustCoreClient({
        binaryPath: binary,
        dbPath: path.join(root, "core.sqlite3"),
      });
      try {
        const journal = new NativeRustWorkerMessageJournal(client, {
          now: () => 3_000,
          consumerId: "pressure-consumer",
          maxMessages: 1,
          maxBytes: 100_000,
        });
        const first = await journal.stage({ ...input, requestId: "pressure-1" });
        expect(first.pressure).toMatchObject({ messages: 1, highWater: true });
        await expect(
          journal.stage({ ...input, requestId: "pressure-2" }),
        ).rejects.toMatchObject({ code: "BACKPRESSURED" });
        const cancel = await journal.stage({
          ...input,
          requestId: "pressure-cancel",
          command: { type: "input.cancel", reason: "stop now" },
        });
        expect(cancel.command).toEqual({ type: "input.cancel", reason: "stop now" });
        await cancel.release();
        await first.release();
      } finally {
        await client.close();
      }
    },
  );
});
