#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = resolve(packageRoot, "../../node_modules/vitest/vitest.mjs");
const ffiOption = "--experimental-ffi";
const inheritedOptions = process.env.NODE_OPTIONS?.trim() ?? "";
const nodeOptions = inheritedOptions.split(/\s+/u).includes(ffiOption)
  ? inheritedOptions
  : [inheritedOptions, ffiOption].filter(Boolean).join(" ");

const result = spawnSync(process.execPath, [vitest, "run", "opentui"], {
  cwd: packageRoot,
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: "inherit",
});

if (result.error !== undefined) throw result.error;
if (result.signal !== null) {
  console.error(`OpenTUI tests terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
