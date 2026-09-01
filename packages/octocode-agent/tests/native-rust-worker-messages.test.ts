import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NativeRustWorkerMessageJournal,
  type NativeWorkerCommunicationCore,
} from "../src/native-rust-worker-messages.js";
import {
  NativeRustCoreClient,
  NativeRustCoreError,
  type NativeRustCommunicationClaimResult,
  type NativeRustCoreObject,
} from "../src/native-rust-core.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function coreFixture(overrides: Partial<NativeWorkerCommunicationCore> = {}) {
  let payload: NativeRustCoreObject | undefined;
  const core: NativeWorkerCommunicationCore = {
    communicationEnqueue: vi.fn(async (input) => {
      payload = input.payload;
      return { enqueued: true };
    }),
    communicationClaim: vi.fn(async (input) => [
      {
        messageId: String(
          (payload?.["message"] as { readonly id?: unknown } | undefined)?.id,
        ),
        payload: payload ?? {},
        availableAt: input.now,
        leaseUntil: input.now + input.leaseMs,
        leaseGeneration: 1,
      },
    ]),
    communicationAck: vi.fn(async () => ({ acknowledged: true })),
    communicationRelease: vi.fn(async () => ({ released: true })),
    communicationAbandonPrefix: vi.fn(async () => []),
    ...overrides,
  };
  return core;
}

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
  const binary = fs.existsSync(releaseBinary) ? releaseBinary : debugBinary;

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
    expect(core.communicationEnqueue).toHaveBeenCalledOnce();
    expect(core.communicationClaim).toHaveBeenCalledOnce();

    await lease.ack();

    expect(core.communicationAck).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "request-1",
        consumerId: "process-parent-1",
        leaseGeneration: 1,
      }),
    );
    await lease.ack();
    expect(core.communicationAck).toHaveBeenCalledOnce();
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
    expect(core.communicationClaim).not.toHaveBeenCalled();
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
    expect(core.communicationRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "request-cancel",
        leaseGeneration: 1,
      }),
    );
  });

  it("fails closed when Rust returns a malformed or mismatched AI message", async () => {
    const core = coreFixture({
      communicationClaim: vi.fn(async () => [
        {
          messageId: "request-1",
          payload: {
            schemaVersion: 1,
            message: { id: "request-1", role: "tool", parts: [] },
          },
          availableAt: 1_000,
          leaseUntil: 31_000,
          leaseGeneration: 1,
        },
      ]),
    });
    const journal = new NativeRustWorkerMessageJournal(core, {
      now: () => 1_000,
    });

    await expect(journal.stage(input)).rejects.toThrow(/message envelope/i);
    expect(core.communicationRelease).toHaveBeenCalledOnce();
  });

  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "fails closed when Rust returns invalid lease generation %s",
    async (leaseGeneration) => {
      const core = coreFixture({
        communicationClaim: vi.fn(
          async () =>
            [
              {
                messageId: "request-1",
                payload: {},
                availableAt: 1_000,
                leaseUntil: 31_000,
                ...(leaseGeneration === undefined ? {} : { leaseGeneration }),
              },
            ] as unknown as NativeRustCommunicationClaimResult,
        ),
      });

      await expect(
        new NativeRustWorkerMessageJournal(core, { now: () => 1_000 }).stage(
          input,
        ),
      ).rejects.toThrow(/claim is malformed/i);
      expect(core.communicationAck).not.toHaveBeenCalled();
      expect(core.communicationRelease).not.toHaveBeenCalled();
    },
  );

  it("propagates stale lease receipt conflicts without marking the lease settled", async () => {
    const stale = new NativeRustCoreError("remote", "stale", "CONFLICT");
    const core = coreFixture({
      communicationAck: vi.fn(async () => {
        throw stale;
      }),
    });
    const lease = await new NativeRustWorkerMessageJournal(core, {
      now: () => 1_000,
    }).stage(input);

    await expect(lease.ack()).rejects.toBe(stale);
    await expect(lease.ack()).rejects.toBe(stale);
    expect(core.communicationAck).toHaveBeenCalledTimes(2);
    expect(core.communicationAck).toHaveBeenLastCalledWith(
      expect.objectContaining({ leaseGeneration: 1 }),
    );
  });

  it.skipIf(!fs.existsSync(binary))(
    "abandons a stranded AI message after a real Rust process restart without replay",
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
      // Simulate a crash: close the owning process without ack or release.
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
          secondJournal.abandonSession("session-1"),
        ).resolves.toEqual({ abandoned: 1 });
        await expect(
          secondClient.communicationClaim({
            channel: "worker-input:session-1:worker-1:request-restart",
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
});
