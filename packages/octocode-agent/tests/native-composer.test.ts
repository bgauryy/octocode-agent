import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ComposerPasteStore,
  NATIVE_SLASH_COMMANDS,
  WorkspaceFileCatalog,
  applyComposerSuggestion,
  parseComposerTrigger,
} from "../src/native-composer.js";

describe("native composer lossless paste", () => {
  it("keeps small pastes inline and compacts large pastes without losing normalized content", () => {
    const store = new ComposerPasteStore();

    expect(store.prepare("small\r\npaste")).toEqual({
      displayText: "small\npaste",
      compacted: false,
    });

    const unicode = `\u001B[31m${"😀é\n".repeat(11)}\u001B[0m`;
    const prepared = store.prepare(unicode);
    expect(prepared.compacted).toBe(true);
    expect(prepared.displayText).toMatch(/^\[paste #1:[a-f0-9]{12} \+12 lines\]$/u);
    expect(store.expand(`before ${prepared.displayText} after`)).toBe(
      `before ${"😀é\n".repeat(11)} after`,
    );
  });

  it("uses a character marker for a long single line and rejects ambiguous marker collisions", () => {
    const store = new ComposerPasteStore();
    const content = "x".repeat(1_001);
    const prepared = store.prepare(content);

    expect(prepared.displayText).toMatch(
      /^\[paste #1:[a-f0-9]{12} 1001 chars\]$/u,
    );
    expect(
      store.expand(`${prepared.displayText} ${prepared.displayText}`),
    ).toBe(`${prepared.displayText} ${prepared.displayText}`);
  });

  it("leaves forged and unknown markers literal and clears retained payloads", () => {
    const store = new ComposerPasteStore();
    const prepared = store.prepare("line\n".repeat(11));
    const unknown = "[paste #999:000000000000 +12 lines]";

    expect(store.expand(unknown)).toBe(unknown);
    store.clear();
    expect(store.expand(prepared.displayText)).toBe(prepared.displayText);

    const next = store.prepare("line\n".repeat(11));
    expect(next.displayText).toMatch(/^\[paste #1:/u);
  });

  it("falls back to the complete sanitized text when bounded marker storage is exhausted", () => {
    const store = new ComposerPasteStore({ maxStoredBytes: 32 });
    const content = "😀".repeat(1_001);
    const prepared = store.prepare(content);

    expect(prepared).toEqual({ displayText: content, compacted: false });
    expect(store.retainedBytes).toBe(0);
  });
});

describe("native composer completion", () => {
  it("recognizes slash commands only at the start of the composer", () => {
    expect(parseComposerTrigger("/pla", 4)).toEqual({
      mode: "command",
      fragment: "pla",
      start: 0,
      end: 4,
    });
    expect(parseComposerTrigger("explain /plan", 13)).toBeUndefined();
  });

  it("recognizes an active @ file token and replaces only that token", () => {
    const value = "review @src/old.ts please";
    const trigger = parseComposerTrigger(value, 18);
    expect(trigger).toEqual({
      mode: "file",
      fragment: "src/old.ts",
      start: 7,
      end: 18,
    });
    expect(
      applyComposerSuggestion(value, trigger!, {
        id: "file-new",
        kind: "file",
        label: "src/new file.ts",
        insertText: "src/new file.ts",
      }),
    ).toEqual({ value: 'review @"src/new file.ts" please', cursor: 25 });
  });

  it("provides stable described native commands", () => {
    expect(NATIVE_SLASH_COMMANDS.map(({ name }) => name)).toEqual([
      "automations",
      "cancel",
      "clear",
      "compact",
      "exit",
      "help",
      "plan",
      "octocode-agents",
      "octocode-inbox",
      "quit",
      "settings",
      "skills",
      "status",
      "steer",
      "thinking",
      "workers",
      "tools",
      "commands",
    ]);
    expect(
      NATIVE_SLASH_COMMANDS.every(({ description }) => description.length > 0),
    ).toBe(true);
  });

  it("discovers bounded safe workspace files and excludes generated and secret paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-composer-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "hidden"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, "src", "alpha file.ts"), "export {};");
    fs.writeFileSync(path.join(root, "src", "beta.ts"), "export {};");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=value");
    fs.writeFileSync(path.join(root, "node_modules", "hidden", "bad.ts"), "");

    const catalog = new WorkspaceFileCatalog(root);
    const matches = await catalog.search("alp");

    expect(matches.map(({ label }) => label)).toEqual(["src/alpha file.ts"]);
    expect(
      (await catalog.search("")).some(({ label }) => label.includes(".env")),
    ).toBe(false);
    expect(
      (await catalog.search("")).some(({ label }) =>
        label.includes("node_modules"),
      ),
    ).toBe(false);
  });
});
