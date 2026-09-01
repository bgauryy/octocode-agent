import { describe, expect, it } from "vitest";

import {
  NATIVE_SLASH_COMMANDS,
  PI_COMMAND_PARITY,
  PI_GENERIC_COMMAND_ADAPTER_HOLD,
  nativeCommandAlias,
} from "../src/native-command-catalog.js";

const PI_PRODUCTION_COMMANDS = [
  "commands",
  "octocode",
  "octocode-harness",
  "octocode-now",
  "octocode-tasks",
  "octocode-skills",
  "octocode-agents",
  "octocode-cron",
  "settings",
  "mcp",
  "octocode-setup",
  "octocode-skills-update",
  "octocode-plan",
  "octocode-theme",
  "octocode-chrome",
  "octocode-footer",
  "octocode-permissions",
  "octocode-profile",
  "octocode-inbox",
  "octocode-palette",
  "octocode-rewind",
  "octocode-dial",
  "octocode-watch",
  "octocode-export",
  "octocode-cleanup",
] as const;

describe("Pi 0.84.2 command parity ledger", () => {
  it("accounts for every concrete production registration without inventing the generic adapter name", () => {
    expect(PI_COMMAND_PARITY.map(({ piName }) => piName)).toEqual(
      PI_PRODUCTION_COMMANDS,
    );
    expect(new Set(PI_COMMAND_PARITY.map(({ piName }) => piName)).size).toBe(
      25,
    );
    expect(PI_GENERIC_COMMAND_ADAPTER_HOLD).toMatchObject({
      status: "HOLD",
      concreteName: null,
    });
  });

  it("publishes only MATCH or approved semantic aliases and leaves blockers undiscoverable", () => {
    const nativeNames = new Set(NATIVE_SLASH_COMMANDS.map(({ name }) => name));
    for (const row of PI_COMMAND_PARITY) {
      if (row.status === "BLOCKED")
        expect(nativeNames.has(row.piName)).toBe(false);
      else {
        expect(nativeNames.has(row.piName)).toBe(true);
        expect(row.nativeOwner).toBeTruthy();
      }
    }
  });

  it("blocks partial Pi aliases instead of exposing narrower native behavior under their names", () => {
    const blockedNames = [
      "octocode",
      "octocode-now",
      "octocode-tasks",
      "octocode-skills",
      "mcp",
      "octocode-plan",
      "octocode-theme",
      "octocode-palette",
      "octocode-dial",
    ] as const;
    const nativeNames = new Set(NATIVE_SLASH_COMMANDS.map(({ name }) => name));

    for (const name of blockedNames) {
      expect(
        PI_COMMAND_PARITY.find(({ piName }) => piName === name),
      ).toMatchObject({ status: "BLOCKED" });
      expect(nativeCommandAlias(name)).toBeUndefined();
      expect(nativeNames.has(name)).toBe(false);
    }
  });

  it("publishes durable native automations without reviving the session cron alias", () => {
    const nativeNames = new Set(NATIVE_SLASH_COMMANDS.map(({ name }) => name));
    expect(nativeNames.has("automations")).toBe(true);
    expect(nativeNames.has("octocode-cron")).toBe(false);
    expect(nativeCommandAlias("octocode-cron")).toBeUndefined();
    expect(
      PI_COMMAND_PARITY.find(({ piName }) => piName === "octocode-cron"),
    ).toMatchObject({
      status: "BLOCKED",
    });
  });
});
