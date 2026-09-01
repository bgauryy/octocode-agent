import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CANONICAL_HOST_SCENARIOS } from "../src/host-conformance.js";
import {
  createNativePersistenceRestartProbe,
  createNativeSessionLifecycleProbe,
} from "./support/native-session-persistence-probes.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "octocode-native-session-conformance-"),
  );
  roots.push(root);
  return root;
}

function scenario(id: "session-lifecycle" | "persistence-restart") {
  return CANONICAL_HOST_SCENARIOS.find((candidate) => candidate.id === id)!;
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("native Rust session production conformance probes", () => {
  it("exercises the complete native session lifecycle through the durable tree", async () => {
    const receipt = await createNativeSessionLifecycleProbe(temporaryRoot())({
      scenario: scenario("session-lifecycle"),
      signal: new AbortController().signal,
    });

    expect(receipt.source).toBe("native-production-composition");
    expect(receipt.events).toEqual([
      {
        kind: "session.lifecycle",
        data: {
          named: "production-probe-session",
          treeRoots: 1,
          navigated: true,
          forked: true,
          resumed: true,
          exported: true,
          stopped: true,
        },
      },
    ]);
    expect(receipt.observations).toEqual([
      {
        kind: "session.durable-lifecycle",
        data: expect.objectContaining({
          sessionCount: 2,
          rootCount: 1,
          sessions: expect.arrayContaining([
            expect.objectContaining({ parentSessionId: null }),
            expect.objectContaining({ parentSessionId: expect.any(String) }),
          ]),
        }),
      },
    ]);
  });

  it("reopens a fresh Rust process and keeps every durable descriptor out of parity data", async () => {
    const receipt = await createNativePersistenceRestartProbe(temporaryRoot())({
      scenario: scenario("persistence-restart"),
      signal: new AbortController().signal,
    });

    expect(receipt.source).toBe("native-production-composition");
    expect(receipt.events).toEqual([
      {
        kind: "persistence.restarted",
        data: { deterministicProjection: true },
      },
    ]);
    expect(receipt.events[0]?.data).not.toHaveProperty("entryCount");
    expect(receipt.observations).toEqual([
      {
        kind: "persistence.durable-entry-count",
        data: expect.objectContaining({ count: expect.any(Number) }),
      },
      {
        kind: "persistence.durable-lifecycle-descriptors",
        data: expect.objectContaining({
          count: expect.any(Number),
          descriptors: expect.any(Array),
          preservedAcrossRestart: true,
        }),
      },
      {
        kind: "persistence.restart-processes",
        data: { count: 2 },
      },
    ]);
    const count = (
      receipt.observations?.[0]?.data as { readonly count: number }
    ).count;
    const descriptors = (
      receipt.observations?.[1]?.data as {
        readonly count: number;
        readonly descriptors: readonly unknown[];
      }
    );
    expect(count).toBeGreaterThan(0);
    expect(descriptors.count).toBe(count);
    expect(descriptors.descriptors).toHaveLength(count);
  });
});
