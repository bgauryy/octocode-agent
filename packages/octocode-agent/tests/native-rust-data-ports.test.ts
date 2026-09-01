import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEffectAdmissionReceipt,
  RuntimeFailure,
  revision,
  sessionEventId,
  sessionId,
  type EffectAdmissionReceipt,
  type SessionEvent,
} from "@octocodeai/agent-core";
import { describe, expect, it, vi } from "vitest";

import {
  NativeRustEffectLedger,
  NativeRustSessionIndex,
  NativeRustSessionStore,
} from "../src/native-rust-data-ports.js";
import {
  NativeRustCoreClient,
  NativeRustCoreError,
  type NativeRustCoreJson,
  type NativeRustCoreObject,
  type NativeRustEffectBeginInput,
  type NativeRustEffectKey,
  type NativeRustEffectGetResult,
  type NativeRustEffectMutationResult,
  type NativeRustEffectSettleInput,
  type NativeRustSessionAppendInput,
  type NativeRustSessionLoadInput,
  type NativeRustSessionResult,
} from "../src/native-rust-core.js";

const SESSION = sessionId("rust-session");

function event(
  sequence: number,
  content = `message-${sequence}`,
): SessionEvent {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    eventId: sessionEventId(`event-${sequence}`),
    revision: revision(String(sequence)),
    sequence,
    timestamp: sequence,
    visibility: "model",
    event: { type: "message.appended", role: "user", content },
  };
}

function receipt(operation = "write-file"): EffectAdmissionReceipt {
  return {
    schemaVersion: 1,
    operation,
    input: { path: "file.ts" },
    effects: ["write"],
    policy: {
      trust: { workspace: "trusted", managedOnly: false },
      approval: "never",
      approved: true,
      plan: { authority: "runtime", active: true, revision: 1 },
      lockTargets: ["file.ts"],
      receipts: [{ policy: "test", decision: { effect: "allow" }, order: 0 }],
    },
  };
}

interface SharedFakeState {
  readonly sessions: Map<string, NativeRustCoreJson[]>;
  readonly effects: Map<string, NativeRustCoreObject>;
  clock: number;
}

function fakeClient(state: SharedFakeState) {
  return {
    async sessionAppend(
      input: NativeRustSessionAppendInput,
    ): Promise<NativeRustSessionResult> {
      const current = state.sessions.get(input.sessionId) ?? [];
      if (input.expectedRevision !== String(current.length))
        throw new NativeRustCoreError("remote", "conflict", "CONFLICT");
      const events = [...current, ...input.events];
      state.sessions.set(input.sessionId, events);
      return {
        sessionId: input.sessionId,
        revision: String(events.length),
        events,
      };
    },
    async sessionLoad(
      input: NativeRustSessionLoadInput,
    ): Promise<NativeRustSessionResult> {
      const events = state.sessions.get(input.sessionId);
      if (events === undefined) return null;
      return {
        sessionId: input.sessionId,
        revision: String(events.length),
        events,
      };
    },
    async effectBegin(
      input: NativeRustEffectBeginInput,
    ): Promise<NativeRustEffectMutationResult> {
      const mapKey = `${input.sessionId}\0${input.key}`;
      const existing = state.effects.get(mapKey);
      if (existing !== undefined)
        return JSON.stringify(existing["receipt"]) ===
          JSON.stringify(input.receipt)
          ? (existing["state"] as string)
          : "mismatch";
      state.effects.set(mapKey, {
        key: input.key,
        state: "started",
        updatedAt: ++state.clock,
        receipt: input.receipt,
      });
      return "acquired";
    },
    async effectGet(
      input: NativeRustEffectKey,
    ): Promise<NativeRustEffectGetResult> {
      return (state.effects.get(`${input.sessionId}\0${input.key}`) ??
        null) as NativeRustEffectGetResult;
    },
    async effectSettle(
      input: NativeRustEffectSettleInput,
    ): Promise<NativeRustEffectMutationResult> {
      const mapKey = `${input.sessionId}\0${input.key}`;
      const existing = state.effects.get(mapKey);
      if (existing === undefined)
        throw new NativeRustCoreError("remote", "missing", "NOT_FOUND");
      if (existing["state"] !== "started" && existing["state"] !== input.state)
        throw new NativeRustCoreError("remote", "conflict", "CONFLICT");
      state.effects.set(mapKey, {
        ...existing,
        state: input.state,
        updatedAt: ++state.clock,
      });
      return input.state;
    },
  };
}

function fakeState(): SharedFakeState {
  return { sessions: new Map(), effects: new Map(), clock: 100 };
}

describe("NativeRustSessionStore", () => {
  it("commits discovery metadata in the same append request as session events", async () => {
    const client = fakeClient(fakeState());
    const append = vi.spyOn(client, "sessionAppend");
    const cwdEvent: SessionEvent = {
      ...event(1),
      timestamp: 20,
      event: {
        type: "custom.appended",
        kind: "session.cwd",
        value: "/workspace",
      },
    };

    await new NativeRustSessionStore(client).append(SESSION, revision("0"), [
      cwdEvent,
    ]);

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        index: { cwd: "/workspace", parentSessionId: null, updatedAt: 20 },
      }),
    );
  });

  it("round-trips events through the canonical agent-core projection", async () => {
    const store = new NativeRustSessionStore(fakeClient(fakeState()));
    await expect(
      store.append(SESSION, revision("0"), [event(1)]),
    ).resolves.toBe("1");
    const loaded = await store.load(SESSION);
    expect(loaded.events).toEqual([event(1)]);
    expect(loaded.projection).toMatchObject({
      sessionId: SESSION,
      revision: "1",
    });
    expect(loaded.projection.modelContext).toEqual([
      { eventId: "event-1", role: "user", content: "message-1" },
    ]);
  });

  it("maps remote compare-and-append conflicts to a safe session conflict", async () => {
    const state = fakeState();
    const first = new NativeRustSessionStore(fakeClient(state));
    const stale = new NativeRustSessionStore(fakeClient(state));
    await first.append(SESSION, revision("0"), [event(1)]);
    const failure = await stale
      .append(SESSION, revision("0"), [event(1, "stale")])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeFailure);
    expect(failure).toMatchObject({
      category: "session-conflict",
      retry: "safe",
    });
  });

  it("rejects malformed durable records as session corruption", async () => {
    const client = fakeClient(fakeState());
    client.sessionLoad = async () => ({
      sessionId: String(SESSION),
      revision: "2",
      events: [event(1) as unknown as NativeRustCoreJson],
    });
    const failure = await new NativeRustSessionStore(client)
      .load(SESSION)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeFailure);
    expect(failure).toMatchObject({
      category: "session-corruption",
      retry: "unsafe",
    });
  });
});

describe("NativeRustSessionIndex", () => {
  it("resolves newest, parent, child, previous, and next from the Rust index", async () => {
    const parent = sessionId("parent");
    const child = sessionId("child");
    const index = new NativeRustSessionIndex({
      sessionList: async () => [
        {
          sessionId: child,
          revision: "2",
          cwd: "/workspace",
          parentSessionId: parent,
          updatedAt: 20,
        },
        {
          sessionId: parent,
          revision: "1",
          cwd: "/workspace",
          parentSessionId: null,
          updatedAt: 10,
        },
      ],
    });

    await expect(index.list("/workspace")).resolves.toMatchObject([
      { sessionId: child, parentSessionId: parent },
      { sessionId: parent },
    ]);
    await expect(index.resolve(child, "parent", "/workspace")).resolves.toBe(
      parent,
    );
    await expect(index.resolve(parent, "child", "/workspace")).resolves.toBe(
      child,
    );
    await expect(index.resolve(child, "previous", "/workspace")).resolves.toBe(
      parent,
    );
    await expect(index.resolve(parent, "next", "/workspace")).resolves.toBe(
      child,
    );
  });
});

describe("NativeRustEffectLedger", () => {
  it("preserves exact ledger states and records", async () => {
    const state = fakeState();
    const ledger = new NativeRustEffectLedger(fakeClient(state), SESSION);
    await expect(ledger.begin("effect-1", receipt())).resolves.toBe("acquired");
    await expect(ledger.begin("effect-1", receipt())).resolves.toBe("started");
    await expect(ledger.begin("effect-1", receipt("different"))).resolves.toBe(
      "mismatch",
    );
    await expect(ledger.get("effect-1")).resolves.toMatchObject({
      key: "effect-1",
      state: "started",
      updatedAt: 101,
      receipt: receipt(),
    });
    await ledger.settle("effect-1", "committed");
    await expect(ledger.get("effect-1")).resolves.toMatchObject({
      key: "effect-1",
      state: "committed",
      updatedAt: 102,
    });
    await expect(
      ledger.settle("effect-1", "committed"),
    ).resolves.toBeUndefined();
  });

  it("rejects an expired first admission while allowing an existing record to win", async () => {
    const state = fakeState();
    const expired = createEffectAdmissionReceipt(receipt(), {
      expiresAt: 50,
      policyRevision: 7,
    });
    const ledger = new NativeRustEffectLedger(fakeClient(state), SESSION, () => 100);

    await expect(ledger.begin("fresh-expired", expired)).rejects.toMatchObject({
      category: "conflict",
    });
    expect(state.effects.has(`${SESSION}\0fresh-expired`)).toBe(false);

    state.effects.set(`${SESSION}\0existing-expired`, {
      key: "existing-expired",
      state: "started",
      updatedAt: 25,
      receipt: expired as unknown as NativeRustCoreObject,
    });
    await expect(ledger.begin("existing-expired", expired)).resolves.toBe("started");
    const different = createEffectAdmissionReceipt(receipt("different"), {
      expiresAt: 50,
      policyRevision: 7,
    });
    await expect(ledger.begin("existing-expired", different)).resolves.toBe("mismatch");
  });

  it("rejects a persisted receipt whose canonical integrity digest is invalid", async () => {
    const state = fakeState();
    const valid = createEffectAdmissionReceipt(receipt(), {
      expiresAt: 500,
      policyRevision: 7,
    });
    state.effects.set(`${SESSION}\0corrupt-receipt`, {
      key: "corrupt-receipt",
      state: "started",
      updatedAt: 25,
      receipt: { ...valid, digest: "0".repeat(64) } as unknown as NativeRustCoreObject,
    });

    await expect(
      new NativeRustEffectLedger(fakeClient(state), SESSION).get("corrupt-receipt"),
    ).rejects.toMatchObject({ category: "persistence" });
  });

  it("admits one winner across four independent clients", async () => {
    const binary = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../octocode-agent-core-rust/target/debug/octocode-agent-core-rust",
    );
    if (!fs.existsSync(binary)) {
      const state = fakeState();
      const ledgers = Array.from(
        { length: 4 },
        () => new NativeRustEffectLedger(fakeClient(state), SESSION),
      );
      const results = await Promise.all(
        ledgers.map((ledger) => ledger.begin("contended", receipt())),
      );
      expect(results.filter((result) => result === "acquired")).toHaveLength(1);
      expect(results.filter((result) => result === "started")).toHaveLength(3);
      return;
    }

    const temp = fs.mkdtempSync(
      path.join(os.tmpdir(), "octocode-rust-contention-"),
    );
    const dbPath = path.join(temp, "core.sqlite3");
    const clients = Array.from(
      { length: 4 },
      () => new NativeRustCoreClient({ binaryPath: binary, dbPath }),
    );
    try {
      const sessionStore = new NativeRustSessionStore(clients[0]!);
      await sessionStore.append(SESSION, revision("0"), [event(1)]);
      const ledgers = clients.map(
        (client) => new NativeRustEffectLedger(client, SESSION),
      );
      const results = await Promise.all(
        ledgers.map((ledger) => ledger.begin("contended", receipt())),
      );
      expect(results.filter((result) => result === "acquired")).toHaveLength(1);
      expect(results.filter((result) => result === "started")).toHaveLength(3);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
