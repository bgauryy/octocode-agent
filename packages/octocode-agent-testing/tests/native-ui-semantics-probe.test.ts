import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createProductionPiScenarioSuite } from "@octocodeai/pi-extension";

import { CANONICAL_HOST_SCENARIOS } from "../src/host-conformance.js";
import { createNativeUiSemanticsProbe } from "./support/native-ui-semantics-probe.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("native UI semantics production probe", () => {
  test("uses native presentation and interaction composition while preserving the Pi semantic trace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-native-ui-"));
    roots.push(root);
    const scenario = CANONICAL_HOST_SCENARIOS.find(
      ({ id }) => id === "ui-semantics",
    )!;
    const receipt = await createNativeUiSemanticsProbe(root)({
      scenario,
      signal: new AbortController().signal,
    });

    expect(receipt.source).toBe("native-production-composition");
    expect(receipt.effects).toEqual([]);
    expect(receipt.events).toEqual([
      { kind: "ui.select", data: { title: "probe:select", count: 2 } },
      { kind: "ui.confirm", data: { title: "probe:confirm" } },
      { kind: "ui.input", data: { title: "probe:input" } },
      { kind: "ui.editor", data: { title: "probe:editor" } },
      {
        kind: "ui.notify",
        data: { message: "probe:notify", type: "info" },
      },
      {
        kind: "ui.status",
        data: { key: "probe:status", active: true },
      },
      { kind: "ui.title", data: { title: "probe:title" } },
      {
        kind: "ui.command-observed",
        data: {
          hasUI: false,
          selected: null,
          confirmed: false,
          inputAvailable: false,
          editorAvailable: false,
        },
      },
      {
        kind: "ui.headless",
        data: {
          mode: "json",
          rejected: false,
          providerCalls: 0,
          hasUI: false,
          dialogsReturnedValues: false,
        },
      },
    ]);
    expect(receipt.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "native.ui.workflow",
          data: expect.objectContaining({
            oneAtATime: true,
            discuss: true,
            priorAnswersPreserved: true,
          }),
        }),
        expect.objectContaining({
          kind: "native.ui.visible-state",
          data: {
            plan: true,
            task: true,
            worker: true,
            tool: true,
            thinking: true,
            hiddenThinkingPayloadVisible: false,
            colorRequiredForMeaning: false,
          },
        }),
      ]),
    );
  });

  test("rejects a malformed canonical scenario before touching presentation state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-native-ui-"));
    roots.push(root);
    await expect(
      createNativeUiSemanticsProbe(root)({
        scenario: {
          id: "ui-semantics",
          title: "Exercise semantic UI requests",
          requirements: ["ui", "headless"],
          input: { adapters: ["interactive"] },
          applicability: { kind: "cross-host" },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/interactive and headless/u);
  });

  test("matches the installed Pi SDK semantic receipt exactly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-ui-parity-"));
    roots.push(root);
    const scenario = CANONICAL_HOST_SCENARIOS.find(
      ({ id }) => id === "ui-semantics",
    )!;
    const piProbe =
      createProductionPiScenarioSuite(root).scenarioProbes["ui-semantics"];
    if (!piProbe)
      throw new Error("Installed Pi UI production probe is missing");
    const pi = await piProbe({
      scenario,
      signal: new AbortController().signal,
    });
    const native = await createNativeUiSemanticsProbe(root)({
      scenario,
      signal: new AbortController().signal,
    });

    expect(native.events).toEqual(pi.events);
    expect(native.effects).toEqual(pi.effects);
  });
});
