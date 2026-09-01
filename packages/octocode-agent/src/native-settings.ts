import fs from "node:fs";
import { createHash } from "node:crypto";
import { writePrivateFileAtomic } from "./private-fs.js";
import type {
  NativeRustCoreClient,
  NativeRustCoreJson,
} from "./native-rust-core.js";

export interface StoredSettings {
  schemaVersion: 1;
  revision: string;
  values: Record<string, unknown>;
}

export interface NativeSettingsStorage {
  read(): StoredSettings | Promise<StoredSettings>;
  commit(
    expectedRevision: string,
    values: Record<string, unknown>,
  ): StoredSettings | Promise<StoredSettings>;
}
const secretKey = /(?:api[_-]?key|secret|token|password|credential)/i;
const digest = (values: Record<string, unknown>): string =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");

function parse(content: string): StoredSettings {
  const value = JSON.parse(content) as Partial<StoredSettings> &
    Record<string, unknown>;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schemaVersion === undefined &&
    value.revision === undefined &&
    value.values === undefined
  ) {
    return { schemaVersion: 1, revision: digest(value), values: value };
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.revision !== "string" ||
    !value.values ||
    typeof value.values !== "object" ||
    Array.isArray(value.values)
  )
    throw new Error("Invalid settings record");
  return value as StoredSettings;
}
function redact(value: unknown, key = ""): unknown {
  if (secretKey.test(key)) return value == null ? null : { configured: true };
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([nested, item]) => [
        nested,
        redact(item, nested),
      ]),
    );
  return value;
}

export class FileSettingsStorage {
  constructor(readonly file: string) {}
  read(): StoredSettings {
    if (!fs.existsSync(this.file))
      return { schemaVersion: 1, revision: "0", values: {} };
    if (fs.lstatSync(this.file).isSymbolicLink())
      throw new Error("Settings path must not be a symbolic link");
    try {
      return parse(fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      const backup = `${this.file}.bak`;
      if (!fs.existsSync(backup)) throw error;
      const recovered = parse(fs.readFileSync(backup, "utf8"));
      writePrivateFileAtomic(
        this.file,
        JSON.stringify(recovered, null, 2) + "\n",
      );
      return recovered;
    }
  }
  commit(
    expectedRevision: string,
    values: Record<string, unknown>,
  ): StoredSettings {
    const current = this.read();
    if (current.revision !== expectedRevision)
      throw new Error(
        `Settings revision conflict: expected ${expectedRevision}, current ${current.revision}`,
      );
    const next: StoredSettings = {
      schemaVersion: 1,
      revision: digest(values),
      values,
    };
    if (fs.existsSync(this.file))
      writePrivateFileAtomic(
        `${this.file}.bak`,
        JSON.stringify(current, null, 2) + "\n",
      );
    writePrivateFileAtomic(this.file, JSON.stringify(next, null, 2) + "\n");
    return next;
  }
  project(): { revision: string; values: Record<string, unknown> } {
    const current = this.read();
    return {
      revision: current.revision,
      values: redact(current.values) as Record<string, unknown>,
    };
  }
}

function isJsonValue(value: unknown): value is NativeRustCoreJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function rustRecord(record: Awaited<ReturnType<NativeRustCoreClient["settingsGet"]>>): StoredSettings {
  if (record === null)
    return { schemaVersion: 1, revision: "0", values: {} };
  const values = record["values"];
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("Native data core settings record is malformed");
  return {
    schemaVersion: 1,
    revision: record.revision,
    values: values as Record<string, unknown>,
  };
}

/** Rust-backed global settings owner with an optional import-only JSON source. */
export class NativeRustSettingsStorage implements NativeSettingsStorage {
  constructor(
    readonly core: Pick<
      NativeRustCoreClient,
      "settingsGet" | "settingsCompareAndSet"
    >,
    readonly legacyImport?: FileSettingsStorage,
  ) {}

  async read(): Promise<StoredSettings> {
    let current = rustRecord(await this.core.settingsGet("global"));
    if (
      current.revision === "0" &&
      Object.keys(current.values).length === 0 &&
      this.legacyImport !== undefined
    ) {
      const legacy = this.legacyImport.read();
      if (Object.keys(legacy.values).length > 0) {
        try {
          current = await this.commit("0", legacy.values);
        } catch {
          current = rustRecord(await this.core.settingsGet("global"));
        }
      }
    }
    return current;
  }

  async commit(
    expectedRevision: string,
    values: Record<string, unknown>,
  ): Promise<StoredSettings> {
    if (!isJsonValue(values))
      throw new Error("Settings values must be JSON-compatible");
    return rustRecord(
      await this.core.settingsCompareAndSet("global", expectedRevision, values),
    );
  }
}
