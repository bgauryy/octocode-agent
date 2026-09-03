import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

export type NativeRustCoreJson =
  | null
  | boolean
  | number
  | string
  | readonly NativeRustCoreJson[]
  | { readonly [key: string]: NativeRustCoreJson };
export type NativeRustCoreObject = {
  readonly [key: string]: NativeRustCoreJson;
};

export interface NativeRustCoreChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type NativeRustCoreSpawn = (
  binaryPath: string,
  args: readonly string[],
) => NativeRustCoreChild;

export interface NativeRustCoreOptions {
  readonly binaryPath: string;
  readonly dbPath: string;
  readonly maxRequestBytes?: number;
  readonly maxResponseLineBytes?: number;
  readonly closeGraceMs?: number;
  readonly terminateGraceMs?: number;
  readonly spawn?: NativeRustCoreSpawn;
}

export interface NativeRustHealthResult extends NativeRustCoreObject {
  readonly status: string;
}
export interface NativeRustSessionIndexInput extends NativeRustCoreObject {
  readonly cwd: string | null;
  readonly parentSessionId: string | null;
  readonly updatedAt: number;
}
export interface NativeRustSessionAppendInput extends NativeRustCoreObject {
  readonly sessionId: string;
  readonly expectedRevision: string;
  readonly events: readonly NativeRustCoreJson[];
  readonly index: NativeRustSessionIndexInput | null;
}
export interface NativeRustSessionLoadInput extends NativeRustCoreObject {
  readonly sessionId: string;
}
interface NativeRustSessionPageInput extends NativeRustCoreObject {
  readonly sessionId: string;
  readonly afterSequence: string | null;
  readonly expectedRevision: string | null;
  readonly maxEvents: number;
  readonly maxBytes: number;
}
interface NativeRustSessionPageEvent extends NativeRustCoreObject {
  readonly sequence: string;
  readonly event: NativeRustCoreJson;
}
interface NativeRustSessionPage extends NativeRustCoreObject {
  readonly sessionId: string;
  readonly revision: string;
  readonly afterSequence: string | null;
  readonly events: readonly NativeRustSessionPageEvent[];
  readonly nextCursor: string | null;
  readonly done: boolean;
}
export interface NativeRustSessionListInput extends NativeRustCoreObject {
  readonly cwd: string;
  readonly limit: number;
}
export interface NativeRustSessionRecord extends NativeRustCoreObject {
  readonly revision: string;
}
export type NativeRustSessionResult = NativeRustSessionRecord | null;
export type NativeRustSessionListResult = readonly NativeRustCoreObject[];
export interface NativeRustEffectKey extends NativeRustCoreObject {
  readonly sessionId: string;
  readonly key: string;
}
export interface NativeRustEffectBeginInput extends NativeRustEffectKey {
  readonly receipt: NativeRustCoreObject;
}
export interface NativeRustEffectSettleInput extends NativeRustEffectKey {
  readonly state: string;
}
export type NativeRustEffectMutationResult = string;
export interface NativeRustEffectRecord extends NativeRustCoreObject {
  readonly key: string;
  readonly state: string;
  readonly receipt: NativeRustCoreObject;
  readonly updatedAt: number;
}
export type NativeRustEffectGetResult = NativeRustEffectRecord | null;
export interface NativeRustCommunicationEnqueueInput extends NativeRustCoreObject {
  readonly channel: string;
  readonly messageId: string;
  readonly availableAt: number;
  readonly payload: NativeRustCoreObject;
}
export interface NativeRustCommunicationClaimInput extends NativeRustCoreObject {
  readonly channel: string;
  readonly consumerId: string;
  readonly now: number;
  readonly leaseMs: number;
  readonly limit: number;
}
export interface NativeRustCommunicationReceiptInput extends NativeRustCoreObject {
  readonly channel: string;
  readonly messageId: string;
  readonly consumerId: string;
  readonly leaseGeneration: number;
}
export type NativeRustCommunicationMutationResult = NativeRustCoreObject;
export interface NativeRustCommunicationClaimRecord extends NativeRustCoreObject {
  readonly messageId: string;
  readonly payload: NativeRustCoreObject;
  readonly availableAt: number;
  readonly leaseUntil: number;
  readonly leaseGeneration: number;
}
export type NativeRustCommunicationClaimResult =
  readonly NativeRustCommunicationClaimRecord[];
export interface NativeRustCommunicationAbandonPrefixInput extends NativeRustCoreObject {
  readonly channelPrefix: string;
  readonly limit: number;
}
export interface NativeRustCommunicationAbandonedRecord extends NativeRustCoreObject {
  readonly channel: string;
  readonly messageId: string;
}
export type NativeRustCommunicationAbandonPrefixResult =
  readonly NativeRustCommunicationAbandonedRecord[];
export type NativeRustWorkerAuthority = NativeRustCoreObject;
export interface NativeRustWorkerMailboxKey extends NativeRustCoreObject {
  readonly authority: NativeRustWorkerAuthority;
  readonly authorityDigest: string;
  readonly mailboxGeneration: number;
}
export type NativeRustWorkerMailboxOpenInput = NativeRustWorkerMailboxKey & {
  readonly createdAt: number;
  readonly maxMessages?: number;
  readonly maxBytes?: number;
};
export interface NativeRustWorkerMailboxEnqueueInput extends NativeRustWorkerMailboxKey {
  readonly messageId: string;
  readonly sender: string;
  readonly recipient: string;
  readonly commandKind: string;
  readonly lane: "data" | "control";
  readonly payload: NativeRustCoreObject;
  readonly payloadDigest: string;
  readonly availableAt: number;
  readonly createdAt: number;
}
export interface NativeRustWorkerMailboxClaimInput extends NativeRustWorkerMailboxKey {
  readonly consumerId: string;
  readonly now: number;
  readonly leaseMs: number;
  readonly limit: number;
}
export interface NativeRustWorkerMailboxLeaseInput extends NativeRustWorkerMailboxKey {
  readonly messageId: string;
  readonly consumerId: string;
  readonly leaseGeneration: number;
  readonly now: number;
}
export interface NativeRustWorkerMailboxExtendInput extends NativeRustWorkerMailboxLeaseInput {
  readonly leaseMs: number;
}
export interface NativeRustWorkerMailboxSettleInput extends NativeRustWorkerMailboxLeaseInput {
  readonly outcomeDigest: string;
  readonly tombstoneExpiresAt: number;
}
export interface NativeRustWorkerMailboxTerminalizeInput extends NativeRustWorkerMailboxSettleInput {
  readonly state: "uncertain" | "dead-lettered";
}
export interface NativeRustWorkerMailboxListInput extends NativeRustWorkerMailboxKey {
  readonly afterSequence: number;
  readonly limit: number;
}
export interface NativeRustWorkerMailboxOpenResult extends NativeRustCoreObject {
  readonly schemaVersion: 1;
  readonly mailboxGeneration: number;
  readonly nextSequence: number;
  readonly sealed: boolean;
  readonly idempotent: boolean;
}
export type NativeRustWorkerMailboxMutationResult = NativeRustCoreObject & {
  readonly schemaVersion: 1;
  readonly messageId: string;
  readonly state: string;
  readonly idempotent: boolean;
  readonly sequence?: number;
  readonly leaseGeneration?: number;
  readonly pressure?: NativeRustCoreObject;
};
export interface NativeRustWorkerMailboxClaimRecord extends NativeRustCoreObject {
  readonly schemaVersion: 1;
  readonly messageId: string;
  readonly sequence: number;
  readonly sender: string;
  readonly recipient: string;
  readonly commandKind: string;
  readonly lane: "data" | "control";
  readonly payload: NativeRustCoreObject;
  readonly payloadDigest: string;
  readonly state: "leased";
  readonly leaseOwner: string;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: number;
}
export type NativeRustWorkerMailboxClaimResult = readonly NativeRustWorkerMailboxClaimRecord[];
export type NativeRustWorkerMailboxListResult = readonly NativeRustCoreObject[];

export interface NativeRustWorkerWorktreeKey extends NativeRustCoreObject {
  readonly authority: NativeRustWorkerAuthority;
  readonly authorityDigest: string;
  readonly worktreeGeneration: number;
}
export interface NativeRustWorkerWorktreeReserveInput extends NativeRustWorkerWorktreeKey {
  readonly repositoryId: string;
  readonly commonDirId: string;
  readonly generatedPath: string;
  readonly baseOid: string;
  readonly currentHeadOid: string;
  readonly privateRef: string;
  readonly gitWorktreeId: string;
  readonly lockTokenDigest: string;
  readonly createdAt: number;
}
export type NativeRustWorkerWorktreeTransitionInput = NativeRustWorkerWorktreeKey & {
  readonly expectedState: string;
  readonly targetState: string;
  readonly currentHeadOid?: string;
  readonly lastCleanStatusDigest?: string;
  readonly updatedAt: number;
};
export interface NativeRustWorkerWorktreeMutationResult extends NativeRustCoreObject {
  readonly schemaVersion: 1;
  readonly worktreeGeneration: number;
  readonly state: string;
  readonly idempotent: boolean;
}
export type NativeRustWorkerWorktreeGetResult = NativeRustCoreObject | null;

export interface NativeRustWorkerHandoffKey extends NativeRustWorkerMailboxKey {
  readonly handoffId: string;
}
export interface NativeRustWorkerHandoffOpenInput extends NativeRustWorkerHandoffKey {
  readonly createdAt: number;
}
export interface NativeRustWorkerHandoffGenerationInput extends NativeRustWorkerHandoffKey {
  readonly expectedGeneration: number;
  readonly updatedAt: number;
}
export interface NativeRustWorkerHandoffTransitionInput extends NativeRustWorkerHandoffGenerationInput {
  readonly expectedState: string;
  readonly targetState: string;
}
export interface NativeRustWorkerHandoffSettleInput extends NativeRustWorkerHandoffKey {
  readonly expectedGeneration: number;
  readonly outcome: NativeRustCoreObject;
  readonly outcomeDigest: string;
  readonly receipt: NativeRustCoreObject;
  readonly receiptDigest: string;
  readonly settledAt: number;
}
export interface NativeRustWorkerHandoffAckInput extends NativeRustWorkerHandoffKey {
  readonly receiptDigest: string;
  readonly acknowledgedAt: number;
}
export type NativeRustWorkerHandoffMutationResult = NativeRustCoreObject & {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly state?: string;
  readonly generation?: number;
  readonly receipt?: NativeRustCoreObject;
  readonly receiptDigest?: string;
  readonly acknowledgedAt?: number;
  readonly idempotent: boolean;
};
export interface NativeRustSettingsRecord extends NativeRustCoreObject {
  readonly revision: string;
}
export type NativeRustSettingsResult = NativeRustSettingsRecord | null;
export type NativeRustLifecycleAppendResult = NativeRustCoreObject;
export type NativeRustLifecycleListResult = readonly NativeRustCoreObject[];
export type NativeRustAutomationDefinitionInput = NativeRustCoreObject;
export interface NativeRustAutomationListInput extends NativeRustCoreObject {
  readonly limit: number;
  readonly states: readonly string[];
}
export interface NativeRustAutomationCancelInput extends NativeRustCoreObject {
  readonly id: string;
  readonly expectedRevision: number;
  readonly cancelledAt: number;
}
export interface NativeRustAutomationCandidateInput extends NativeRustCoreObject {
  readonly automationId: string;
  readonly scheduledFor: number;
}
export interface NativeRustAutomationClaimInput extends NativeRustCoreObject {
  readonly ownerId: string;
  readonly now: number;
  readonly leaseMs: number;
  readonly limit: number;
  readonly candidates: readonly NativeRustAutomationCandidateInput[];
}
export interface NativeRustAutomationOwnershipInput extends NativeRustCoreObject {
  readonly runId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
}
export interface NativeRustAutomationHeartbeatInput extends NativeRustAutomationOwnershipInput {
  readonly now: number;
  readonly leaseMs: number;
}
export interface NativeRustAutomationSettleInput extends NativeRustAutomationOwnershipInput {
  readonly outcome: NativeRustCoreObject;
}
export type NativeRustAutomationDefinitionResult = NativeRustCoreObject;
export type NativeRustAutomationListResult =
  readonly NativeRustAutomationDefinitionResult[];
export type NativeRustAutomationClaimResult = readonly NativeRustCoreObject[];
export type NativeRustAutomationRunResult = NativeRustCoreObject;
export interface NativeRustWorkGraphItemInput extends NativeRustCoreObject {
  readonly itemId: string;
  readonly dependsOn: readonly string[];
}
export interface NativeRustWorkPutGraphInput extends NativeRustCoreObject {
  readonly graphId: string;
  readonly items: readonly NativeRustWorkGraphItemInput[];
}
export interface NativeRustWorkGraphKey extends NativeRustCoreObject {
  readonly graphId: string;
}
export interface NativeRustWorkClaimInput extends NativeRustWorkGraphKey {
  readonly ownerId: string;
  readonly now: number;
  readonly leaseMs: number;
  readonly limit: number;
}
export interface NativeRustWorkOwnershipInput extends NativeRustWorkGraphKey {
  readonly itemId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
}
export interface NativeRustWorkHeartbeatInput extends NativeRustWorkOwnershipInput {
  readonly now: number;
  readonly leaseMs: number;
}
export interface NativeRustWorkSettleInput extends NativeRustWorkOwnershipInput {
  readonly completedAt: number;
  readonly outcome: NativeRustCoreJson;
}
export interface NativeRustWorkGraphSummary extends NativeRustCoreObject {
  readonly schemaVersion: 1;
  readonly graphId: string;
  readonly itemCount: number;
}
export type NativeRustWorkItemState =
  "pending" | "claimed" | "succeeded" | "failed" | "blocked";
export interface NativeRustWorkGraphItem extends NativeRustCoreObject {
  readonly itemId: string;
  readonly ordinal: number;
  readonly dependsOn: readonly string[];
  readonly state: NativeRustWorkItemState;
  readonly fencingToken: number;
  readonly ownerId: string | null;
  readonly leaseExpiresAt: number | null;
  readonly outcome: NativeRustCoreJson;
  readonly blockedBy: readonly string[];
}
export interface NativeRustWorkGraph extends NativeRustCoreObject {
  readonly schemaVersion: 1;
  readonly graphId: string;
  readonly items: readonly NativeRustWorkGraphItem[];
}
export type NativeRustWorkGraphResult = NativeRustWorkGraph | null;
export interface NativeRustWorkClaim extends NativeRustCoreObject {
  readonly schemaVersion: 1;
  readonly graphId: string;
  readonly itemId: string;
  readonly state: "claimed";
  readonly ownerId: string;
  readonly leaseExpiresAt: number;
  readonly fencingToken: number;
}
export type NativeRustWorkClaimResult = readonly NativeRustWorkClaim[];
export interface NativeRustWorkSettlement extends NativeRustCoreObject {
  readonly schemaVersion: 1;
  readonly graphId: string;
  readonly itemId: string;
  readonly state: "succeeded" | "failed";
  readonly fencingToken: number;
  readonly outcome: NativeRustCoreJson;
}

export class NativeRustCoreError extends Error {
  constructor(
    readonly category:
      "validation" | "cancelled" | "protocol" | "process" | "remote" | "closed",
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "NativeRustCoreError";
  }
}

interface PendingRequest {
  resolve(value: NativeRustCoreJson): void;
  reject(error: NativeRustCoreError): void;
  cleanup?(): void;
  cancelled?: boolean;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const SESSION_PAGE_FRAME_RESERVE_BYTES = 1024;
const MAX_SESSION_PAGE_RESULT_BYTES =
  DEFAULT_MAX_BYTES - SESSION_PAGE_FRAME_RESERVE_BYTES;
const MIN_SESSION_PAGE_RESULT_BYTES = 128;
const SESSION_PAGE_MAX_EVENTS = 256;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const DEFAULT_TERMINATE_GRACE_MS = 1_000;

function positive(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1)
    throw new NativeRustCoreError(
      "validation",
      `${name} must be a positive integer`,
    );
  return selected;
}

function nonEmpty(value: string, name: string): string {
  if (!value.trim() || value.includes("\0"))
    throw new NativeRustCoreError("validation", `${name} is invalid`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revision(
  value: string,
  category: "validation" | "protocol" = "validation",
): string {
  if (
    !/^(?:0|[1-9]\d*)$/u.test(value) ||
    BigInt(value) > 9_223_372_036_854_775_807n
  ) {
    throw new NativeRustCoreError(
      category,
      "Native data core revision must be a canonical non-negative i64 decimal string",
    );
  }
  return value;
}

function sessionResult(value: NativeRustCoreJson): NativeRustSessionResult {
  if (value === null) return null;
  if (!isObject(value) || typeof value["revision"] !== "string") {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core session result is malformed",
    );
  }
  revision(value["revision"], "protocol");
  return value as NativeRustSessionRecord;
}

function settingsResult(value: NativeRustCoreJson): NativeRustSettingsResult {
  if (value === null) return null;
  if (!isObject(value) || typeof value["revision"] !== "string") {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core settings result is malformed",
    );
  }
  revision(value["revision"], "protocol");
  return value as NativeRustSettingsRecord;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !value.includes("\0")
  );
}

function sessionPageResult(
  value: NativeRustCoreJson,
  expected: NativeRustSessionPageInput,
): NativeRustSessionPage | null {
  if (value === null) return null;
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "sessionId",
      "revision",
      "afterSequence",
      "events",
      "nextCursor",
      "done",
    ]) ||
    value["sessionId"] !== expected.sessionId ||
    value["afterSequence"] !== expected.afterSequence ||
    typeof value["revision"] !== "string" ||
    !Array.isArray(value["events"]) ||
    value["events"].length > expected.maxEvents ||
    typeof value["done"] !== "boolean"
  ) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core session page is malformed",
    );
  }
  const durableRevision = revision(value["revision"], "protocol");
  if (
    expected.expectedRevision !== null &&
    durableRevision !== expected.expectedRevision
  ) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core session page revision changed",
    );
  }
  const after = BigInt(expected.afterSequence ?? "0");
  if (BigInt(durableRevision) < after) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core session page cursor exceeds its revision",
    );
  }
  const events: NativeRustSessionPageEvent[] = [];
  let sequence = after;
  for (const candidate of value["events"]) {
    if (
      !isObject(candidate) ||
      !exactKeys(candidate, ["sequence", "event"]) ||
      typeof candidate["sequence"] !== "string"
    ) {
      throw new NativeRustCoreError(
        "protocol",
        "Native data core session page event is malformed",
      );
    }
    const current = revision(candidate["sequence"], "protocol");
    if (BigInt(current) !== sequence + 1n) {
      throw new NativeRustCoreError(
        "protocol",
        "Native data core session page ordering is invalid",
      );
    }
    sequence = BigInt(current);
    events.push({
      sequence: current,
      event: candidate["event"] as NativeRustCoreJson,
    });
  }
  const done = value["done"];
  const nextCursor = value["nextCursor"];
  if (done) {
    if (nextCursor !== null || sequence !== BigInt(durableRevision)) {
      throw new NativeRustCoreError(
        "protocol",
        "Native data core completed session page is inconsistent",
      );
    }
  } else if (
    events.length === 0 ||
    typeof nextCursor !== "string" ||
    revision(nextCursor, "protocol") !== sequence.toString() ||
    sequence >= BigInt(durableRevision)
  ) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core session page cursor did not advance",
    );
  }
  return {
    sessionId: expected.sessionId,
    revision: durableRevision,
    afterSequence: expected.afterSequence,
    events,
    nextCursor: done ? null : (nextCursor as string),
    done,
  };
}

function communicationClaimResult(
  value: NativeRustCoreJson,
  limit: number,
): NativeRustCommunicationClaimResult {
  if (!Array.isArray(value) || value.length > limit) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core communication claim result is malformed",
    );
  }
  const seen = new Set<string>();
  return value.map((candidate): NativeRustCommunicationClaimRecord => {
    if (
      !isObject(candidate) ||
      !exactKeys(candidate, [
        "messageId",
        "payload",
        "availableAt",
        "leaseUntil",
        "leaseGeneration",
      ]) ||
      !validIdentifier(candidate["messageId"]) ||
      !isObject(candidate["payload"]) ||
      !safeInteger(candidate["availableAt"]) ||
      !safeInteger(candidate["leaseUntil"]) ||
      !safeInteger(candidate["leaseGeneration"], 1) ||
      seen.has(candidate["messageId"])
    ) {
      throw new NativeRustCoreError(
        "protocol",
        "Native data core communication claim result is malformed",
      );
    }
    seen.add(candidate["messageId"]);
    return candidate as NativeRustCommunicationClaimRecord;
  });
}

function communicationAbandonPrefixResult(
  value: NativeRustCoreJson,
  limit: number,
): NativeRustCommunicationAbandonPrefixResult {
  if (!Array.isArray(value) || value.length > limit)
    throw new NativeRustCoreError(
      "protocol",
      "Native data core communication abandon result is malformed",
    );
  return value.map((candidate) => {
    if (
      !isObject(candidate) ||
      !exactKeys(candidate, ["channel", "messageId"]) ||
      !validIdentifier(candidate["channel"]) ||
      !validIdentifier(candidate["messageId"])
    )
      throw new NativeRustCoreError(
        "protocol",
        "Native data core communication abandon result is malformed",
      );
    return candidate as NativeRustCommunicationAbandonedRecord;
  });
}

function communicationReceipt(
  input: NativeRustCommunicationReceiptInput,
): void {
  if (
    !exactKeys(input, [
      "channel",
      "messageId",
      "consumerId",
      "leaseGeneration",
    ]) ||
    !validIdentifier(input.channel) ||
    !validIdentifier(input.messageId) ||
    !validIdentifier(input.consumerId) ||
    !safeInteger(input.leaseGeneration, 1)
  ) {
    throw new NativeRustCoreError(
      "validation",
      "Native data core communication receipt is malformed",
    );
  }
}

const workerAuthorityRequiredKeys = [
  "schemaVersion",
  "workerId",
  "correlationId",
  "rootAgentId",
  "parentSessionId",
  "workspaceId",
  "workspaceGeneration",
  "trustRevision",
  "permissionMode",
  "capabilityDigest",
  "effectAdmissionId",
  "ownershipGeneration",
] as const;
const workerAuthorityOptionalKeys = ["planId", "planRevision", "planStepId"] as const;

function validWorkerAuthority(value: unknown): value is NativeRustWorkerAuthority {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        !workerAuthorityRequiredKeys.includes(
          key as (typeof workerAuthorityRequiredKeys)[number],
        ) &&
        !workerAuthorityOptionalKeys.includes(
          key as (typeof workerAuthorityOptionalKeys)[number],
        ),
    ) ||
    workerAuthorityRequiredKeys.some((key) => !keys.includes(key)) ||
    value["schemaVersion"] !== 1 ||
    !safeInteger(value["workspaceGeneration"]) ||
    !safeInteger(value["ownershipGeneration"])
  )
    return false;
  for (const key of [
    "workerId",
    "correlationId",
    "rootAgentId",
    "parentSessionId",
    "workspaceId",
    "trustRevision",
    "permissionMode",
    "capabilityDigest",
    "effectAdmissionId",
  ])
    if (!validIdentifier(value[key])) return false;
  if (value["planId"] !== undefined && !validIdentifier(value["planId"]))
    return false;
  if (
    value["planRevision"] !== undefined &&
    (!safeInteger(value["planRevision"]) || value["planId"] === undefined)
  )
    return false;
  return !(
    value["planStepId"] !== undefined &&
    (!validIdentifier(value["planStepId"]) || value["planId"] === undefined)
  );
}

function workerKey(
  input: NativeRustCoreObject,
  generationKey: "mailboxGeneration" | "worktreeGeneration",
): boolean {
  return (
    validWorkerAuthority(input["authority"]) &&
    validIdentifier(input["authorityDigest"]) &&
    safeInteger(input[generationKey])
  );
}

function exactRequiredOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function assertWorkerInput(
  input: NativeRustCoreObject,
  generationKey: "mailboxGeneration" | "worktreeGeneration",
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    !workerKey(input, generationKey) ||
    !exactRequiredOptionalKeys(input, required, optional)
  )
    throw new NativeRustCoreError("validation", "Native worker durability input is malformed");
}

function workerMailboxOpenResult(
  value: NativeRustCoreJson,
): NativeRustWorkerMailboxOpenResult {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "mailboxGeneration",
      "nextSequence",
      "sealed",
      "idempotent",
    ]) ||
    value["schemaVersion"] !== 1 ||
    !safeInteger(value["mailboxGeneration"]) ||
    !safeInteger(value["nextSequence"], 1) ||
    typeof value["sealed"] !== "boolean" ||
    typeof value["idempotent"] !== "boolean"
  )
    throw new NativeRustCoreError("protocol", "Worker mailbox open result is malformed");
  return value as NativeRustWorkerMailboxOpenResult;
}

function workerMailboxMutationResult(
  value: NativeRustCoreJson,
): NativeRustWorkerMailboxMutationResult {
  if (!isObject(value))
    throw new NativeRustCoreError("protocol", "Worker mailbox mutation result is malformed");
  const keys = Object.keys(value);
  const allowed = [
    "schemaVersion",
    "messageId",
    "sequence",
    "state",
    "idempotent",
    "leaseGeneration",
    "pressure",
  ];
  if (
    keys.some((key) => !allowed.includes(key)) ||
    ![4, 5, 6].includes(keys.length) ||
    value["schemaVersion"] !== 1 ||
    !validIdentifier(value["messageId"]) ||
    !validIdentifier(value["state"]) ||
    typeof value["idempotent"] !== "boolean" ||
    (value["sequence"] !== undefined && !safeInteger(value["sequence"], 1)) ||
    (value["leaseGeneration"] !== undefined &&
      !safeInteger(value["leaseGeneration"], 1))
  )
    throw new NativeRustCoreError("protocol", "Worker mailbox mutation result is malformed");
  if (value["pressure"] !== undefined) {
    const pressure = value["pressure"];
    if (
      !isObject(pressure) ||
      !exactKeys(pressure, ["messages", "bytes", "highWater"]) ||
      !safeInteger(pressure["messages"]) ||
      !safeInteger(pressure["bytes"]) ||
      typeof pressure["highWater"] !== "boolean"
    )
      throw new NativeRustCoreError("protocol", "Worker mailbox pressure is malformed");
  }
  return value as NativeRustWorkerMailboxMutationResult;
}

function workerMailboxClaimResult(
  value: NativeRustCoreJson,
  limit: number,
): NativeRustWorkerMailboxClaimResult {
  if (!Array.isArray(value) || value.length > limit)
    throw new NativeRustCoreError("protocol", "Worker mailbox claim result is malformed");
  let previous = 0;
  return value.map((entry) => {
    if (
      !isObject(entry) ||
      !exactKeys(entry, [
        "schemaVersion","messageId","sequence","sender","recipient","commandKind","lane",
        "payload","payloadDigest","state","leaseOwner","leaseGeneration","leaseExpiresAt",
      ]) ||
      entry["schemaVersion"] !== 1 ||
      !validIdentifier(entry["messageId"]) ||
      !safeInteger(entry["sequence"], 1) ||
      entry["sequence"] <= previous ||
      !validIdentifier(entry["sender"]) ||
      !validIdentifier(entry["recipient"]) ||
      !validIdentifier(entry["commandKind"]) ||
      !["data", "control"].includes(String(entry["lane"])) ||
      !isObject(entry["payload"]) ||
      !validIdentifier(entry["payloadDigest"]) ||
      entry["state"] !== "leased" ||
      !validIdentifier(entry["leaseOwner"]) ||
      !safeInteger(entry["leaseGeneration"], 1) ||
      !safeInteger(entry["leaseExpiresAt"])
    )
      throw new NativeRustCoreError("protocol", "Worker mailbox claim result is malformed");
    previous = entry["sequence"];
    return entry as NativeRustWorkerMailboxClaimRecord;
  });
}

function workerMailboxListResult(
  value: NativeRustCoreJson,
  limit: number,
): NativeRustWorkerMailboxListResult {
  if (!Array.isArray(value) || value.length > limit)
    throw new NativeRustCoreError("protocol", "Worker mailbox list result is malformed");
  let previous = 0;
  for (const entry of value) {
    if (
      !isObject(entry) ||
      !exactKeys(entry, [
        "schemaVersion","messageId","sequence","sender","recipient","commandKind","lane",
        "payloadDigest","state","leaseGeneration","outcomeDigest","tombstoneExpiresAt",
      ]) ||
      entry["schemaVersion"] !== 1 ||
      !validIdentifier(entry["messageId"]) ||
      !safeInteger(entry["sequence"], 1) ||
      entry["sequence"] <= previous ||
      !validIdentifier(entry["sender"]) ||
      !validIdentifier(entry["recipient"]) ||
      !validIdentifier(entry["commandKind"]) ||
      !["data", "control"].includes(String(entry["lane"])) ||
      !validIdentifier(entry["payloadDigest"]) ||
      !validIdentifier(entry["state"]) ||
      !safeInteger(entry["leaseGeneration"]) ||
      ![null, "string"].includes(
        entry["outcomeDigest"] === null ? null : typeof entry["outcomeDigest"],
      ) ||
      (entry["tombstoneExpiresAt"] !== null && !safeInteger(entry["tombstoneExpiresAt"]))
    )
      throw new NativeRustCoreError("protocol", "Worker mailbox list result is malformed");
    previous = entry["sequence"];
  }
  return value as NativeRustWorkerMailboxListResult;
}

function workerWorktreeMutationResult(value: NativeRustCoreJson): NativeRustWorkerWorktreeMutationResult {
  if (!isObject(value) || !exactKeys(value, ["schemaVersion","worktreeGeneration","state","idempotent"])
    || value["schemaVersion"] !== 1 || !safeInteger(value["worktreeGeneration"])
    || !validIdentifier(value["state"]) || typeof value["idempotent"] !== "boolean")
    throw new NativeRustCoreError("protocol", "Worker worktree mutation result is malformed");
  return value as NativeRustWorkerWorktreeMutationResult;
}

function workerWorktreeGetResult(value: NativeRustCoreJson): NativeRustWorkerWorktreeGetResult {
  if (value === null) return null;
  if (!isObject(value) || !exactKeys(value, ["schemaVersion","worktreeGeneration","repositoryId",
    "commonDirId","generatedPath","baseOid","currentHeadOid","privateRef","gitWorktreeId",
    "lockTokenDigest","state","lastCleanStatusDigest"]) || value["schemaVersion"] !== 1
    || !safeInteger(value["worktreeGeneration"])
    || !["repositoryId", "commonDirId", "generatedPath", "baseOid", "currentHeadOid",
      "privateRef", "gitWorktreeId", "lockTokenDigest", "state"].every((key) =>
      validIdentifier(value[key]))
    || (value["lastCleanStatusDigest"] !== null && !validIdentifier(value["lastCleanStatusDigest"])))
    throw new NativeRustCoreError("protocol", "Worker worktree result is malformed");
  return value as NativeRustCoreObject;
}

function workerHandoffMutationResult(value: NativeRustCoreJson): NativeRustWorkerHandoffMutationResult {
  if (!isObject(value))
    throw new NativeRustCoreError("protocol", "Worker handoff result is malformed");
  const keys = Object.keys(value);
  const allowed = ["schemaVersion","handoffId","state","generation","receipt","receiptDigest",
    "acknowledgedAt","idempotent"];
  if (keys.some((key) => !allowed.includes(key)) || ![4, 5, 7].includes(keys.length)
    || value["schemaVersion"] !== 1 || !validIdentifier(value["handoffId"])
    || typeof value["idempotent"] !== "boolean"
    || (value["state"] !== undefined && !validIdentifier(value["state"]))
    || (value["generation"] !== undefined && !safeInteger(value["generation"]))
    || (value["receipt"] !== undefined && !isObject(value["receipt"]))
    || (value["receiptDigest"] !== undefined && !validIdentifier(value["receiptDigest"]))
    || (value["acknowledgedAt"] !== undefined && !safeInteger(value["acknowledgedAt"])))
    throw new NativeRustCoreError("protocol", "Worker handoff result is malformed");
  return value as NativeRustWorkerHandoffMutationResult;
}

function validSchedule(value: unknown): boolean {
  if (!isObject(value) || typeof value["kind"] !== "string") return false;
  if (value["kind"] === "once")
    return exactKeys(value, ["kind", "at"]) && safeInteger(value["at"]);
  if (value["kind"] === "interval")
    return (
      exactKeys(value, ["kind", "everyMs", "anchorAt"]) &&
      safeInteger(value["everyMs"], 1) &&
      safeInteger(value["anchorAt"])
    );
  return (
    value["kind"] === "cron" &&
    exactKeys(value, ["kind", "expression", "timeZone"]) &&
    validIdentifier(value["expression"]) &&
    validIdentifier(value["timeZone"])
  );
}

function automationDefinitionResult(
  value: NativeRustCoreJson,
): NativeRustAutomationDefinitionResult {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "id",
      "revision",
      "state",
      "schedule",
      "misfirePolicy",
      "retryPolicy",
      "action",
      "createdAt",
      "updatedAt",
    ]) ||
    value["schemaVersion"] !== 1 ||
    !validIdentifier(value["id"]) ||
    !safeInteger(value["revision"]) ||
    !["active", "paused", "cancelled"].includes(String(value["state"])) ||
    !validSchedule(value["schedule"]) ||
    !["skip", "run-once", "catch-up"].includes(
      String(value["misfirePolicy"]),
    ) ||
    !safeInteger(value["createdAt"]) ||
    !safeInteger(value["updatedAt"]) ||
    value["updatedAt"] < value["createdAt"]
  ) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core automation definition is malformed",
    );
  }
  const retry = value["retryPolicy"];
  const action = value["action"];
  if (
    !isObject(retry) ||
    !exactKeys(retry, ["maxAttempts", "backoffMs"]) ||
    !safeInteger(retry["maxAttempts"], 1) ||
    retry["maxAttempts"] > 100 ||
    !safeInteger(retry["backoffMs"]) ||
    retry["backoffMs"] > 86_400_000 ||
    !isObject(action) ||
    !exactKeys(action, ["name", "version", "payload"]) ||
    !validIdentifier(action["name"]) ||
    !safeInteger(action["version"], 1)
  ) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core automation definition is malformed",
    );
  }
  return value as NativeRustAutomationDefinitionResult;
}

function automationListResult(
  value: NativeRustCoreJson,
): NativeRustAutomationListResult {
  if (!Array.isArray(value))
    throw new NativeRustCoreError(
      "protocol",
      "Native data core automation list is malformed",
    );
  return value.map(automationDefinitionResult);
}

function automationClaimResult(
  value: NativeRustCoreJson,
): NativeRustCoreObject {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "runId",
      "automationId",
      "scheduledFor",
      "attempt",
      "state",
      "ownerId",
      "leaseExpiresAt",
      "fencingToken",
    ]) ||
    value["schemaVersion"] !== 1 ||
    !validIdentifier(value["runId"]) ||
    !validIdentifier(value["automationId"]) ||
    !safeInteger(value["scheduledFor"]) ||
    !safeInteger(value["attempt"], 1) ||
    value["state"] !== "claimed" ||
    !validIdentifier(value["ownerId"]) ||
    !safeInteger(value["leaseExpiresAt"]) ||
    !safeInteger(value["fencingToken"], 1)
  ) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core automation claim is malformed",
    );
  }
  return value;
}

function automationClaimsResult(
  value: NativeRustCoreJson,
): NativeRustAutomationClaimResult {
  if (!Array.isArray(value))
    throw new NativeRustCoreError(
      "protocol",
      "Native data core automation claims are malformed",
    );
  return value.map(automationClaimResult);
}

function validOutcome(value: unknown, state: string): boolean {
  if (
    !isObject(value) ||
    value["state"] !== state ||
    !safeInteger(value["completedAt"])
  )
    return false;
  if (state === "succeeded")
    return Object.keys(value).every((key) =>
      ["state", "completedAt", "result"].includes(key),
    );
  if (state === "failed") {
    const error = value["error"];
    return (
      exactKeys(value, ["state", "completedAt", "error"]) &&
      isObject(error) &&
      Object.keys(error).every((key) =>
        ["code", "message", "retryable", "details"].includes(key),
      ) &&
      validIdentifier(error["code"]) &&
      validIdentifier(error["message"]) &&
      typeof error["retryable"] === "boolean"
    );
  }
  return (
    state === "uncertain" &&
    Object.keys(value).every((key) =>
      ["state", "completedAt", "reason", "details"].includes(key),
    ) &&
    validIdentifier(value["reason"])
  );
}

function automationRunResult(
  value: NativeRustCoreJson,
  state: "succeeded" | "failed" | "uncertain",
): NativeRustAutomationRunResult {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "runId",
      "automationId",
      "scheduledFor",
      "attempt",
      "state",
      "outcome",
    ]) ||
    value["schemaVersion"] !== 1 ||
    !validIdentifier(value["runId"]) ||
    !validIdentifier(value["automationId"]) ||
    !safeInteger(value["scheduledFor"]) ||
    !safeInteger(value["attempt"], 1) ||
    value["state"] !== state ||
    !validOutcome(value["outcome"], state)
  ) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core automation run is malformed",
    );
  }
  return value;
}

function workGraphSummaryResult(
  value: NativeRustCoreJson,
  expected: NativeRustWorkPutGraphInput,
): NativeRustWorkGraphSummary {
  if (
    !isObject(value) ||
    !exactKeys(value, ["schemaVersion", "graphId", "itemCount"]) ||
    value["schemaVersion"] !== 1 ||
    value["graphId"] !== expected.graphId ||
    value["itemCount"] !== expected.items.length
  ) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core work graph summary is malformed",
    );
  }
  return value as NativeRustWorkGraphSummary;
}

function validateWorkGraphInput(input: NativeRustWorkPutGraphInput): void {
  if (
    !exactKeys(input, ["graphId", "items"]) ||
    !validIdentifier(input.graphId) ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 1000
  )
    throw new NativeRustCoreError(
      "validation",
      "Native data core work graph request is malformed",
    );
  const ids = new Set<string>();
  for (const item of input.items) {
    if (
      !isObject(item) ||
      !exactKeys(item, ["itemId", "dependsOn"]) ||
      !validIdentifier(item.itemId) ||
      !workIdentifierList(item.dependsOn) ||
      ids.has(item.itemId)
    )
      throw new NativeRustCoreError(
        "validation",
        "Native data core work graph request is malformed",
      );
    ids.add(item.itemId);
  }
  const dependencies = new Map(
    input.items.map((item) => [item.itemId, item.dependsOn] as const),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (itemId: string): void => {
    if (visiting.has(itemId))
      throw new NativeRustCoreError(
        "validation",
        "Native data core work graph contains a cycle",
      );
    if (visited.has(itemId)) return;
    visiting.add(itemId);
    for (const dependency of dependencies.get(itemId) ?? []) {
      if (dependency === itemId || !ids.has(dependency))
        throw new NativeRustCoreError(
          "validation",
          "Native data core work graph dependency is invalid",
        );
      visit(dependency);
    }
    visiting.delete(itemId);
    visited.add(itemId);
  };
  for (const item of input.items) visit(item.itemId);
}

function validateWorkGraphKey(input: NativeRustWorkGraphKey): void {
  if (!exactKeys(input, ["graphId"]) || !validIdentifier(input.graphId))
    throw new NativeRustCoreError(
      "validation",
      "Native data core work graph key is malformed",
    );
}

function validateWorkClaimInput(input: NativeRustWorkClaimInput): void {
  if (
    !exactKeys(input, ["graphId", "ownerId", "now", "leaseMs", "limit"]) ||
    !validIdentifier(input.graphId) ||
    !validIdentifier(input.ownerId) ||
    !safeInteger(input.now) ||
    !safeInteger(input.leaseMs, 1) ||
    input.leaseMs > 86_400_000 ||
    !safeInteger(input.now + input.leaseMs) ||
    !safeInteger(input.limit, 1) ||
    input.limit > 100
  )
    throw new NativeRustCoreError(
      "validation",
      "Native data core work claim request is malformed",
    );
}

function validateWorkHeartbeatInput(input: NativeRustWorkHeartbeatInput): void {
  if (
    !exactKeys(input, [
      "graphId",
      "itemId",
      "ownerId",
      "fencingToken",
      "now",
      "leaseMs",
    ]) ||
    !validIdentifier(input.graphId) ||
    !validIdentifier(input.itemId) ||
    !validIdentifier(input.ownerId) ||
    !safeInteger(input.fencingToken, 1) ||
    !safeInteger(input.now) ||
    !safeInteger(input.leaseMs, 1) ||
    input.leaseMs > 86_400_000 ||
    !safeInteger(input.now + input.leaseMs)
  )
    throw new NativeRustCoreError(
      "validation",
      "Native data core work heartbeat request is malformed",
    );
}

function validateWorkSettleInput(input: NativeRustWorkSettleInput): void {
  if (
    !exactKeys(input, [
      "graphId",
      "itemId",
      "ownerId",
      "fencingToken",
      "completedAt",
      "outcome",
    ]) ||
    !validIdentifier(input.graphId) ||
    !validIdentifier(input.itemId) ||
    !validIdentifier(input.ownerId) ||
    !safeInteger(input.fencingToken, 1) ||
    !safeInteger(input.completedAt)
  )
    throw new NativeRustCoreError(
      "validation",
      "Native data core work settlement request is malformed",
    );
}

function workIdentifierList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 1000 &&
    value.every(validIdentifier) &&
    new Set(value).size === value.length
  );
}

function workGraphResult(
  value: NativeRustCoreJson,
  expectedGraphId: string,
): NativeRustWorkGraphResult {
  if (value === null) return null;
  if (
    !isObject(value) ||
    !exactKeys(value, ["schemaVersion", "graphId", "items"]) ||
    value["schemaVersion"] !== 1 ||
    value["graphId"] !== expectedGraphId ||
    !Array.isArray(value["items"]) ||
    value["items"].length < 1 ||
    value["items"].length > 1000
  ) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core work graph is malformed",
    );
  }
  const seen = new Set<string>();
  const items = value["items"].map((candidate, ordinal) => {
    if (
      !isObject(candidate) ||
      !exactKeys(candidate, [
        "itemId",
        "ordinal",
        "dependsOn",
        "state",
        "fencingToken",
        "ownerId",
        "leaseExpiresAt",
        "outcome",
        "blockedBy",
      ]) ||
      !validIdentifier(candidate["itemId"]) ||
      candidate["ordinal"] !== ordinal ||
      !workIdentifierList(candidate["dependsOn"]) ||
      !["pending", "claimed", "succeeded", "failed", "blocked"].includes(
        String(candidate["state"]),
      ) ||
      !safeInteger(candidate["fencingToken"]) ||
      !workIdentifierList(candidate["blockedBy"]) ||
      seen.has(candidate["itemId"])
    ) {
      throw new NativeRustCoreError(
        "protocol",
        "Native data core work graph item is malformed",
      );
    }
    const claimed = candidate["state"] === "claimed";
    if (
      (claimed &&
        (!validIdentifier(candidate["ownerId"]) ||
          !safeInteger(candidate["leaseExpiresAt"]) ||
          !safeInteger(candidate["fencingToken"], 1) ||
          candidate["outcome"] !== null)) ||
      (!claimed &&
        (candidate["ownerId"] !== null ||
          candidate["leaseExpiresAt"] !== null)) ||
      (candidate["state"] === "pending" && candidate["outcome"] !== null) ||
      ((candidate["state"] === "succeeded" ||
        candidate["state"] === "failed") &&
        candidate["fencingToken"] < 1) ||
      (candidate["state"] !== "blocked" && candidate["blockedBy"].length !== 0)
    ) {
      throw new NativeRustCoreError(
        "protocol",
        "Native data core work graph item ownership is malformed",
      );
    }
    seen.add(candidate["itemId"]);
    return candidate as NativeRustWorkGraphItem;
  });
  for (const item of items) {
    if (
      item.dependsOn.some(
        (dependency) => dependency === item.itemId || !seen.has(dependency),
      ) ||
      item.blockedBy.some((dependency) => !item.dependsOn.includes(dependency))
    ) {
      throw new NativeRustCoreError(
        "protocol",
        "Native data core work graph dependencies are malformed",
      );
    }
  }
  const byId = new Map(items.map((item) => [item.itemId, item] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (itemId: string): void => {
    if (visiting.has(itemId))
      throw new NativeRustCoreError(
        "protocol",
        "Native data core work graph contains a cycle",
      );
    if (visited.has(itemId)) return;
    visiting.add(itemId);
    for (const dependency of byId.get(itemId)?.dependsOn ?? [])
      visit(dependency);
    visiting.delete(itemId);
    visited.add(itemId);
  };
  for (const item of items) visit(item.itemId);
  return { schemaVersion: 1, graphId: expectedGraphId, items };
}

function workClaimRecord(
  value: unknown,
  expected: Pick<NativeRustWorkClaimInput, "graphId" | "ownerId">,
): NativeRustWorkClaim {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "graphId",
      "itemId",
      "state",
      "ownerId",
      "leaseExpiresAt",
      "fencingToken",
    ]) ||
    value["schemaVersion"] !== 1 ||
    value["graphId"] !== expected.graphId ||
    !validIdentifier(value["itemId"]) ||
    value["state"] !== "claimed" ||
    value["ownerId"] !== expected.ownerId ||
    !safeInteger(value["leaseExpiresAt"]) ||
    !safeInteger(value["fencingToken"], 1)
  ) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core work claim is malformed",
    );
  }
  return value as NativeRustWorkClaim;
}

function workClaimsResult(
  value: NativeRustCoreJson,
  expected: NativeRustWorkClaimInput,
): NativeRustWorkClaimResult {
  if (!Array.isArray(value) || value.length > expected.limit)
    throw new NativeRustCoreError(
      "protocol",
      "Native data core work claims are malformed",
    );
  const seen = new Set<string>();
  return value.map((candidate) => {
    const claim = workClaimRecord(candidate, expected);
    if (seen.has(claim.itemId))
      throw new NativeRustCoreError(
        "protocol",
        "Native data core work claims contain duplicates",
      );
    seen.add(claim.itemId);
    return claim;
  });
}

function workHeartbeatResult(
  value: NativeRustCoreJson,
  expected: NativeRustWorkHeartbeatInput,
): NativeRustWorkClaim {
  const claim = workClaimRecord(value, expected);
  if (
    claim.itemId !== expected.itemId ||
    claim.fencingToken !== expected.fencingToken ||
    claim.leaseExpiresAt !== expected.now + expected.leaseMs
  )
    throw new NativeRustCoreError(
      "protocol",
      "Native data core work heartbeat is inconsistent",
    );
  return claim;
}

function workSettlementResult(
  value: NativeRustCoreJson,
  expected: NativeRustWorkSettleInput,
  state: "succeeded" | "failed",
): NativeRustWorkSettlement {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "graphId",
      "itemId",
      "state",
      "fencingToken",
      "outcome",
    ]) ||
    value["schemaVersion"] !== 1 ||
    value["graphId"] !== expected.graphId ||
    value["itemId"] !== expected.itemId ||
    value["state"] !== state ||
    value["fencingToken"] !== expected.fencingToken ||
    !isDeepStrictEqual(value["outcome"], expected.outcome)
  ) {
    throw new NativeRustCoreError(
      "protocol",
      "Native data core work settlement is malformed",
    );
  }
  return value as NativeRustWorkSettlement;
}

function defaultSpawn(
  binaryPath: string,
  args: readonly string[],
): NativeRustCoreChild {
  return spawn(binaryPath, [...args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Strict JSONL bridge to the native agent data core. */
export class NativeRustCoreClient {
  readonly #child: NativeRustCoreChild;
  readonly #maxRequestBytes: number;
  readonly #maxResponseLineBytes: number;
  readonly #sessionPageResultMaxBytes: number;
  readonly #closeGraceMs: number;
  readonly #terminateGraceMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  #requestSequence = 0;
  #stdout = Buffer.alloc(0);
  #writeTail: Promise<void> = Promise.resolve();
  #closing = false;
  #closed = false;
  #failed = false;
  #exitResolved = false;
  readonly #exit: Promise<void>;
  #resolveExit!: () => void;
  #closePromise?: Promise<void>;

  constructor(options: NativeRustCoreOptions) {
    const binaryPath = nonEmpty(
      options.binaryPath,
      "Native data core binary path",
    );
    const dbPath = nonEmpty(options.dbPath, "Native data core database path");
    if (!path.isAbsolute(dbPath))
      throw new NativeRustCoreError(
        "validation",
        "Native data core database path must be absolute",
      );
    this.#maxRequestBytes = positive(
      options.maxRequestBytes,
      DEFAULT_MAX_BYTES,
      "maxRequestBytes",
    );
    this.#maxResponseLineBytes = positive(
      options.maxResponseLineBytes,
      DEFAULT_MAX_BYTES,
      "maxResponseLineBytes",
    );
    this.#sessionPageResultMaxBytes = Math.min(
      MAX_SESSION_PAGE_RESULT_BYTES,
      this.#maxResponseLineBytes - SESSION_PAGE_FRAME_RESERVE_BYTES,
    );
    this.#closeGraceMs = positive(
      options.closeGraceMs,
      DEFAULT_CLOSE_GRACE_MS,
      "closeGraceMs",
    );
    this.#terminateGraceMs = positive(
      options.terminateGraceMs,
      DEFAULT_TERMINATE_GRACE_MS,
      "terminateGraceMs",
    );
    this.#exit = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#child = (options.spawn ?? defaultSpawn)(binaryPath, ["--db", dbPath]);
    this.#child.stderr?.resume();
    this.#child.stdout.on("data", (chunk: Buffer | string) =>
      this.#capture(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    this.#child.stdout.once("end", () => {
      if (this.#stdout.length > 0)
        this.#failProtocol("Native data core emitted an incomplete response");
    });
    this.#child.once("error", () =>
      this.#failProcess("Native data core process could not be started"),
    );
    this.#child.once("close", () => {
      this.#closed = true;
      if (!this.#exitResolved) {
        this.#exitResolved = true;
        this.#resolveExit();
      }
      this.#rejectAll(
        new NativeRustCoreError("process", "Native data core process exited"),
      );
    });
  }

  health(signal?: AbortSignal): Promise<NativeRustHealthResult> {
    return this.#call("health", {}, signal);
  }
  async sessionAppend(
    input: NativeRustSessionAppendInput,
    signal?: AbortSignal,
  ): Promise<NativeRustSessionResult> {
    revision(input.expectedRevision);
    return sessionResult(await this.#call("session.append", input, signal));
  }
  async sessionLoad(
    input: NativeRustSessionLoadInput,
    signal?: AbortSignal,
  ): Promise<NativeRustSessionResult> {
    if (this.#sessionPageResultMaxBytes < MIN_SESSION_PAGE_RESULT_BYTES) {
      throw new NativeRustCoreError(
        "validation",
        "Native data core response limit is too small for session pages",
      );
    }
    const sessionId = nonEmpty(input.sessionId, "Session id");
    const events: NativeRustCoreJson[] = [];
    let afterSequence: string | null = null;
    let expectedRevision: string | null = null;
    for (;;) {
      const request: NativeRustSessionPageInput = {
        sessionId,
        afterSequence,
        expectedRevision,
        maxEvents: SESSION_PAGE_MAX_EVENTS,
        maxBytes: this.#sessionPageResultMaxBytes,
      };
      const page = sessionPageResult(
        await this.#call("session.loadPage", request, signal),
        request,
      );
      if (page === null) {
        if (expectedRevision !== null || afterSequence !== null) {
          throw new NativeRustCoreError(
            "protocol",
            "Native data core session disappeared during pagination",
          );
        }
        return null;
      }
      expectedRevision ??= page.revision;
      for (const entry of page.events) events.push(entry.event);
      if (page.done) {
        return { sessionId, revision: page.revision, events };
      }
      afterSequence = page.nextCursor;
    }
  }
  sessionList(
    input: NativeRustSessionListInput,
    signal?: AbortSignal,
  ): Promise<NativeRustSessionListResult> {
    return this.#call("session.list", input, signal);
  }
  effectBegin(
    input: NativeRustEffectBeginInput,
    signal?: AbortSignal,
  ): Promise<NativeRustEffectMutationResult> {
    return this.#call("effect.begin", input, signal);
  }
  effectGet(
    input: NativeRustEffectKey,
    signal?: AbortSignal,
  ): Promise<NativeRustEffectGetResult> {
    return this.#call("effect.get", input, signal);
  }
  effectSettle(
    input: NativeRustEffectSettleInput,
    signal?: AbortSignal,
  ): Promise<NativeRustEffectMutationResult> {
    return this.#call("effect.settle", input, signal);
  }
  communicationEnqueue(
    input: NativeRustCommunicationEnqueueInput,
    signal?: AbortSignal,
  ): Promise<NativeRustCommunicationMutationResult> {
    return this.#call("communication.enqueue", input, signal);
  }
  async communicationClaim(
    input: NativeRustCommunicationClaimInput,
    signal?: AbortSignal,
  ): Promise<NativeRustCommunicationClaimResult> {
    if (
      !safeInteger(input.limit, 1) ||
      input.limit > 1000 ||
      !safeInteger(input.now) ||
      !safeInteger(input.leaseMs, 1) ||
      !validIdentifier(input.channel) ||
      !validIdentifier(input.consumerId)
    ) {
      throw new NativeRustCoreError(
        "validation",
        "Native data core communication claim is malformed",
      );
    }
    return communicationClaimResult(
      await this.#call("communication.claim", input, signal),
      input.limit,
    );
  }
  async communicationAck(
    input: NativeRustCommunicationReceiptInput,
    signal?: AbortSignal,
  ): Promise<NativeRustCommunicationMutationResult> {
    communicationReceipt(input);
    return await this.#call("communication.ack", input, signal);
  }
  async communicationRelease(
    input: NativeRustCommunicationReceiptInput,
    signal?: AbortSignal,
  ): Promise<NativeRustCommunicationMutationResult> {
    communicationReceipt(input);
    return await this.#call("communication.release", input, signal);
  }
  async communicationAbandonPrefix(
    input: NativeRustCommunicationAbandonPrefixInput,
    signal?: AbortSignal,
  ): Promise<NativeRustCommunicationAbandonPrefixResult> {
    if (
      !validIdentifier(input.channelPrefix) ||
      !safeInteger(input.limit, 1) ||
      input.limit > 1000
    )
      throw new NativeRustCoreError(
        "validation",
        "Native data core communication abandon request is malformed",
      );
    return communicationAbandonPrefixResult(
      await this.#call("communication.abandonPrefix", input, signal),
      input.limit,
    );
  }
  async workerMailboxOpen(
    input: NativeRustWorkerMailboxOpenInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkerMailboxOpenResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration","createdAt"], ["maxMessages","maxBytes"]);
    if (!safeInteger(input.createdAt) || (input.maxMessages !== undefined && !safeInteger(input.maxMessages, 1))
      || (input.maxBytes !== undefined && !safeInteger(input.maxBytes, 1)))
      throw new NativeRustCoreError("validation", "Worker mailbox open input is malformed");
    return workerMailboxOpenResult(await this.#call("worker.mailbox.open", input, signal));
  }
  async workerMailboxEnqueue(
    input: NativeRustWorkerMailboxEnqueueInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkerMailboxMutationResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration",
      "messageId","sender","recipient","commandKind","lane","payload","payloadDigest","availableAt","createdAt"]);
    if (![input.messageId,input.sender,input.recipient,input.commandKind,input.payloadDigest].every(validIdentifier)
      || !["data","control"].includes(input.lane) || !isObject(input.payload)
      || !safeInteger(input.availableAt) || !safeInteger(input.createdAt))
      throw new NativeRustCoreError("validation", "Worker mailbox enqueue input is malformed");
    return workerMailboxMutationResult(await this.#call("worker.mailbox.enqueue", input, signal));
  }
  async workerMailboxClaim(
    input: NativeRustWorkerMailboxClaimInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkerMailboxClaimResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration",
      "consumerId","now","leaseMs","limit"]);
    if (!validIdentifier(input.consumerId) || !safeInteger(input.now) || !safeInteger(input.leaseMs, 1)
      || input.leaseMs > 86_400_000 || !safeInteger(input.limit, 1) || input.limit > 100)
      throw new NativeRustCoreError("validation", "Worker mailbox claim input is malformed");
    return workerMailboxClaimResult(await this.#call("worker.mailbox.claim", input, signal), input.limit);
  }
  async workerMailboxExtend(
    input: NativeRustWorkerMailboxExtendInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkerMailboxMutationResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration",
      "messageId","consumerId","leaseGeneration","now","leaseMs"]);
    if (!validIdentifier(input.messageId) || !validIdentifier(input.consumerId)
      || !safeInteger(input.leaseGeneration, 1) || !safeInteger(input.now)
      || !safeInteger(input.leaseMs, 1) || input.leaseMs > 86_400_000)
      throw new NativeRustCoreError("validation", "Worker mailbox extend input is malformed");
    return workerMailboxMutationResult(await this.#call("worker.mailbox.extend", input, signal));
  }
  async workerMailboxRelease(
    input: NativeRustWorkerMailboxLeaseInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkerMailboxMutationResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration",
      "messageId","consumerId","leaseGeneration","now"]);
    if (!validIdentifier(input.messageId) || !validIdentifier(input.consumerId)
      || !safeInteger(input.leaseGeneration, 1) || !safeInteger(input.now))
      throw new NativeRustCoreError("validation", "Worker mailbox release input is malformed");
    return workerMailboxMutationResult(await this.#call("worker.mailbox.release", input, signal));
  }
  async workerMailboxMarkWritten(
    input: NativeRustWorkerMailboxLeaseInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkerMailboxMutationResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration",
      "messageId","consumerId","leaseGeneration","now"]);
    if (!validIdentifier(input.messageId) || !validIdentifier(input.consumerId)
      || !safeInteger(input.leaseGeneration, 1) || !safeInteger(input.now))
      throw new NativeRustCoreError("validation", "Worker mailbox written input is malformed");
    return workerMailboxMutationResult(await this.#call("worker.mailbox.markWritten", input, signal));
  }
  async workerMailboxAck(
    input: NativeRustWorkerMailboxSettleInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkerMailboxMutationResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration",
      "messageId","consumerId","leaseGeneration","outcomeDigest","now","tombstoneExpiresAt"]);
    if (!validIdentifier(input.messageId) || !validIdentifier(input.consumerId)
      || !validIdentifier(input.outcomeDigest) || !safeInteger(input.leaseGeneration, 1)
      || !safeInteger(input.now) || !safeInteger(input.tombstoneExpiresAt, input.now + 1))
      throw new NativeRustCoreError("validation", "Worker mailbox acknowledgement input is malformed");
    return workerMailboxMutationResult(await this.#call("worker.mailbox.ack", input, signal));
  }
  async workerMailboxTerminalize(
    input: NativeRustWorkerMailboxTerminalizeInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkerMailboxMutationResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration",
      "messageId","consumerId","leaseGeneration","state","outcomeDigest","now","tombstoneExpiresAt"]);
    if (!["uncertain","dead-lettered"].includes(input.state) || !validIdentifier(input.messageId)
      || !validIdentifier(input.consumerId) || !validIdentifier(input.outcomeDigest)
      || !safeInteger(input.leaseGeneration, 1) || !safeInteger(input.now)
      || !safeInteger(input.tombstoneExpiresAt, input.now + 1))
      throw new NativeRustCoreError("validation", "Worker mailbox terminal input is malformed");
    return workerMailboxMutationResult(await this.#call("worker.mailbox.terminalize", input, signal));
  }
  async workerMailboxList(
    input: NativeRustWorkerMailboxListInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkerMailboxListResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration","afterSequence","limit"]);
    if (!safeInteger(input.afterSequence) || !safeInteger(input.limit, 1) || input.limit > 100)
      throw new NativeRustCoreError("validation", "Worker mailbox list input is malformed");
    return workerMailboxListResult(await this.#call("worker.mailbox.list", input, signal), input.limit);
  }
  async workerWorktreeReserve(input: NativeRustWorkerWorktreeReserveInput, signal?: AbortSignal): Promise<NativeRustWorkerWorktreeMutationResult> {
    assertWorkerInput(input, "worktreeGeneration", ["authority","authorityDigest","worktreeGeneration",
      "repositoryId","commonDirId","generatedPath","baseOid","currentHeadOid","privateRef","gitWorktreeId","lockTokenDigest","createdAt"]);
    if (![input.repositoryId,input.commonDirId,input.generatedPath,input.baseOid,input.currentHeadOid,
      input.privateRef,input.gitWorktreeId,input.lockTokenDigest].every(validIdentifier) || !safeInteger(input.createdAt))
      throw new NativeRustCoreError("validation", "Worker worktree reserve input is malformed");
    return workerWorktreeMutationResult(await this.#call("worker.worktree.reserve", input, signal));
  }
  async workerWorktreeGet(input: NativeRustWorkerWorktreeKey, signal?: AbortSignal): Promise<NativeRustWorkerWorktreeGetResult> {
    assertWorkerInput(input, "worktreeGeneration", ["authority","authorityDigest","worktreeGeneration"]);
    return workerWorktreeGetResult(await this.#call("worker.worktree.get", input, signal));
  }
  async workerWorktreeTransition(input: NativeRustWorkerWorktreeTransitionInput, signal?: AbortSignal): Promise<NativeRustWorkerWorktreeMutationResult> {
    assertWorkerInput(input, "worktreeGeneration", ["authority","authorityDigest","worktreeGeneration",
      "expectedState","targetState","updatedAt"], ["currentHeadOid","lastCleanStatusDigest"]);
    if (!validIdentifier(input.expectedState) || !validIdentifier(input.targetState) || !safeInteger(input.updatedAt)
      || (input.currentHeadOid !== undefined && !validIdentifier(input.currentHeadOid))
      || (input.lastCleanStatusDigest !== undefined && !validIdentifier(input.lastCleanStatusDigest)))
      throw new NativeRustCoreError("validation", "Worker worktree transition input is malformed");
    return workerWorktreeMutationResult(await this.#call("worker.worktree.transition", input, signal));
  }
  async workerHandoffOpen(input: NativeRustWorkerHandoffOpenInput, signal?: AbortSignal): Promise<NativeRustWorkerHandoffMutationResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration","handoffId","createdAt"]);
    if (!validIdentifier(input.handoffId) || !safeInteger(input.createdAt))
      throw new NativeRustCoreError("validation", "Worker handoff open input is malformed");
    return workerHandoffMutationResult(await this.#call("worker.handoff.open", input, signal));
  }
  async workerHandoffSeal(input: NativeRustWorkerHandoffGenerationInput, signal?: AbortSignal): Promise<NativeRustWorkerHandoffMutationResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration","handoffId","expectedGeneration","updatedAt"]);
    if (!validIdentifier(input.handoffId) || !safeInteger(input.expectedGeneration) || !safeInteger(input.updatedAt))
      throw new NativeRustCoreError("validation", "Worker handoff seal input is malformed");
    return workerHandoffMutationResult(await this.#call("worker.handoff.seal", input, signal));
  }
  async workerHandoffTransition(input: NativeRustWorkerHandoffTransitionInput, signal?: AbortSignal): Promise<NativeRustWorkerHandoffMutationResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration","handoffId",
      "expectedGeneration","updatedAt","expectedState","targetState"]);
    if (!validIdentifier(input.handoffId) || !safeInteger(input.expectedGeneration) || !safeInteger(input.updatedAt)
      || !validIdentifier(input.expectedState) || !validIdentifier(input.targetState))
      throw new NativeRustCoreError("validation", "Worker handoff transition input is malformed");
    return workerHandoffMutationResult(await this.#call("worker.handoff.transition", input, signal));
  }
  async workerHandoffSettle(input: NativeRustWorkerHandoffSettleInput, signal?: AbortSignal): Promise<NativeRustWorkerHandoffMutationResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration","handoffId",
      "expectedGeneration","outcome","outcomeDigest","receipt","receiptDigest","settledAt"]);
    if (!validIdentifier(input.handoffId) || !safeInteger(input.expectedGeneration) || !isObject(input.outcome)
      || !validIdentifier(input.outcomeDigest) || !isObject(input.receipt) || !validIdentifier(input.receiptDigest)
      || !safeInteger(input.settledAt))
      throw new NativeRustCoreError("validation", "Worker handoff settle input is malformed");
    return workerHandoffMutationResult(await this.#call("worker.handoff.settle", input, signal));
  }
  async workerHandoffAck(input: NativeRustWorkerHandoffAckInput, signal?: AbortSignal): Promise<NativeRustWorkerHandoffMutationResult> {
    assertWorkerInput(input, "mailboxGeneration", ["authority","authorityDigest","mailboxGeneration","handoffId","receiptDigest","acknowledgedAt"]);
    if (!validIdentifier(input.handoffId) || !validIdentifier(input.receiptDigest) || !safeInteger(input.acknowledgedAt))
      throw new NativeRustCoreError("validation", "Worker handoff acknowledgement input is malformed");
    return workerHandoffMutationResult(await this.#call("worker.handoff.ack", input, signal));
  }
  async settingsGet(
    scope: string,
    signal?: AbortSignal,
  ): Promise<NativeRustSettingsResult> {
    return settingsResult(await this.#call("settings.get", { scope }, signal));
  }
  async settingsCompareAndSet(
    scope: string,
    expectedRevision: string,
    values: NativeRustCoreObject,
    signal?: AbortSignal,
  ): Promise<NativeRustSettingsResult> {
    revision(expectedRevision);
    return settingsResult(
      await this.#call(
        "settings.compareAndSet",
        { scope, expectedRevision, values },
        signal,
      ),
    );
  }
  lifecycleAppend(
    streamId: string,
    eventId: string,
    event: NativeRustCoreObject,
    signal?: AbortSignal,
  ): Promise<NativeRustLifecycleAppendResult> {
    return this.#call("lifecycle.append", { streamId, eventId, event }, signal);
  }
  lifecycleList(
    streamId: string,
    afterSequence: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<NativeRustLifecycleListResult> {
    return this.#call(
      "lifecycle.list",
      { streamId, afterSequence, limit },
      signal,
    );
  }
  async automationPut(
    input: NativeRustAutomationDefinitionInput,
    signal?: AbortSignal,
  ): Promise<NativeRustAutomationDefinitionResult> {
    return automationDefinitionResult(
      await this.#call("automation.put", input, signal),
    );
  }
  async automationList(
    input: NativeRustAutomationListInput,
    signal?: AbortSignal,
  ): Promise<NativeRustAutomationListResult> {
    return automationListResult(
      await this.#call("automation.list", input, signal),
    );
  }
  async automationCancel(
    input: NativeRustAutomationCancelInput,
    signal?: AbortSignal,
  ): Promise<NativeRustAutomationDefinitionResult> {
    return automationDefinitionResult(
      await this.#call("automation.cancel", input, signal),
    );
  }
  async automationClaim(
    input: NativeRustAutomationClaimInput,
    signal?: AbortSignal,
  ): Promise<NativeRustAutomationClaimResult> {
    return automationClaimsResult(
      await this.#call("automation.claim", input, signal),
    );
  }
  async automationHeartbeat(
    input: NativeRustAutomationHeartbeatInput,
    signal?: AbortSignal,
  ): Promise<NativeRustCoreObject> {
    return automationClaimResult(
      await this.#call("automation.heartbeat", input, signal),
    );
  }
  async automationComplete(
    input: NativeRustAutomationSettleInput,
    signal?: AbortSignal,
  ): Promise<NativeRustAutomationRunResult> {
    return automationRunResult(
      await this.#call("automation.complete", input, signal),
      "succeeded",
    );
  }
  async automationFail(
    input: NativeRustAutomationSettleInput,
    signal?: AbortSignal,
  ): Promise<NativeRustAutomationRunResult> {
    return automationRunResult(
      await this.#call("automation.fail", input, signal),
      "failed",
    );
  }
  async automationUncertain(
    input: NativeRustAutomationSettleInput,
    signal?: AbortSignal,
  ): Promise<NativeRustAutomationRunResult> {
    return automationRunResult(
      await this.#call("automation.uncertain", input, signal),
      "uncertain",
    );
  }
  async workPutGraph(
    input: NativeRustWorkPutGraphInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkGraphSummary> {
    validateWorkGraphInput(input);
    return workGraphSummaryResult(
      await this.#call("work.putGraph", input, signal),
      input,
    );
  }
  async workGetGraph(
    input: NativeRustWorkGraphKey,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkGraphResult> {
    validateWorkGraphKey(input);
    return workGraphResult(
      await this.#call("work.getGraph", input, signal),
      input.graphId,
    );
  }
  async workClaim(
    input: NativeRustWorkClaimInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkClaimResult> {
    validateWorkClaimInput(input);
    return workClaimsResult(
      await this.#call("work.claim", input, signal),
      input,
    );
  }
  async workHeartbeat(
    input: NativeRustWorkHeartbeatInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkClaim> {
    validateWorkHeartbeatInput(input);
    return workHeartbeatResult(
      await this.#call("work.heartbeat", input, signal),
      input,
    );
  }
  async workComplete(
    input: NativeRustWorkSettleInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkSettlement> {
    validateWorkSettleInput(input);
    return workSettlementResult(
      await this.#call("work.complete", input, signal),
      input,
      "succeeded",
    );
  }
  async workFail(
    input: NativeRustWorkSettleInput,
    signal?: AbortSignal,
  ): Promise<NativeRustWorkSettlement> {
    validateWorkSettleInput(input);
    return workSettlementResult(
      await this.#call("work.fail", input, signal),
      input,
      "failed",
    );
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#closed) return Promise.resolve();
    this.#closing = true;
    this.#closePromise = this.#closeProcess();
    return this.#closePromise;
  }

  async #closeProcess(): Promise<void> {
    await this.#waitForPromise(this.#writeTail, this.#closeGraceMs);
    if (!this.#child.stdin.destroyed && !this.#child.stdin.writableEnded)
      this.#child.stdin.end();
    if (await this.#waitForExit(this.#closeGraceMs)) return;
    this.#child.kill("SIGTERM");
    if (await this.#waitForExit(this.#terminateGraceMs)) return;
    this.#child.kill("SIGKILL");
    if (!(await this.#waitForExit(this.#terminateGraceMs))) {
      this.#closed = true;
      const failure = new NativeRustCoreError(
        "process",
        "Native data core process exit was not observed",
      );
      this.#rejectAll(failure);
      throw failure;
    }
  }

  async #call<T extends NativeRustCoreJson>(
    method: string,
    params: NativeRustCoreObject,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.#closing || this.#closed || this.#failed)
      throw new NativeRustCoreError(
        "closed",
        "Native data core bridge is closed",
      );
    if (signal?.aborted)
      throw new NativeRustCoreError(
        "cancelled",
        "Native data core request was cancelled",
      );
    const id = `native-data:${++this.#requestSequence}`;
    let encoded: string;
    try {
      encoded = `${JSON.stringify({ schemaVersion: 1, id, method, params })}\n`;
    } catch {
      throw new NativeRustCoreError(
        "validation",
        "Native data core request is not JSON serializable",
      );
    }
    if (Buffer.byteLength(encoded) > this.#maxRequestBytes)
      throw new NativeRustCoreError(
        "validation",
        "Native data core request exceeds the byte limit",
      );
    const response = new Promise<NativeRustCoreJson>((resolve, reject) =>
      this.#pending.set(id, { resolve, reject }),
    );
    const write = this.#writeTail.then(async () => {
      if (signal?.aborted) {
        this.#pending.get(id)?.cleanup?.();
        this.#pending.delete(id);
        throw new NativeRustCoreError(
          "cancelled",
          "Native data core request was cancelled",
        );
      }
      if (this.#closed || this.#failed) {
        this.#pending.get(id)?.cleanup?.();
        this.#pending.delete(id);
        throw new NativeRustCoreError(
          "closed",
          "Native data core bridge is closed",
        );
      }
      try {
        const accepted = this.#child.stdin.write(encoded, "utf8");
        this.#armAbort(id, signal);
        if (!accepted) await once(this.#child.stdin, "drain");
      } catch {
        this.#pending.get(id)?.cleanup?.();
        this.#pending.delete(id);
        throw new NativeRustCoreError(
          "process",
          "Native data core request could not be written",
        );
      }
    });
    this.#writeTail = write.catch(() => undefined);
    try {
      await Promise.race([
        write,
        response.then(
          () => undefined,
          () => undefined,
        ),
      ]);
    } catch (error) {
      const failure =
        error instanceof NativeRustCoreError
          ? error
          : new NativeRustCoreError(
              "process",
              "Native data core request could not be written",
            );
      this.#pending.get(id)?.cleanup?.();
      this.#pending.delete(id);
      void response.catch(() => undefined);
      throw failure;
    }
    return response as Promise<T>;
  }

  #armAbort(id: string, signal: AbortSignal | undefined): void {
    if (signal === undefined) return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    const cancel = (): void => {
      const current = this.#pending.get(id);
      if (current !== pending || pending.cancelled) return;
      pending.cancelled = true;
      pending.reject(
        new NativeRustCoreError(
          "cancelled",
          "Native data core request was cancelled",
        ),
      );
    };
    pending.cleanup = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  }

  #capture(chunk: Buffer): void {
    if (this.#failed) return;
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    for (;;) {
      const newline = this.#stdout.indexOf(0x0a);
      if (newline < 0) {
        if (this.#stdout.length > this.#maxResponseLineBytes)
          this.#failProtocol(
            "Native data core response exceeds the byte limit",
          );
        return;
      }
      if (newline > this.#maxResponseLineBytes) {
        this.#failProtocol("Native data core response exceeds the byte limit");
        return;
      }
      const line = this.#stdout.subarray(0, newline).toString("utf8");
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (!line) continue;
      this.#handleLine(line);
      if (this.#failed) return;
    }
  }

  #handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      this.#failProtocol("Native data core emitted malformed JSON");
      return;
    }
    if (
      !isObject(value) ||
      value["schemaVersion"] !== 1 ||
      typeof value["id"] !== "string" ||
      typeof value["ok"] !== "boolean"
    ) {
      this.#failProtocol("Native data core emitted a malformed response");
      return;
    }
    const id = value["id"];
    const pending = this.#pending.get(id);
    if (!pending) {
      this.#failProtocol(
        "Native data core response correlation is invalid or duplicated",
      );
      return;
    }
    if (value["ok"]) {
      if (!Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) {
        this.#failProtocol("Native data core success response is malformed");
        return;
      }
      pending.cleanup?.();
      this.#pending.delete(id);
      pending.resolve(value["result"] as NativeRustCoreJson);
      return;
    }
    const error = value["error"];
    if (
      !isObject(error) ||
      typeof error["code"] !== "string" ||
      !error["code"] ||
      typeof error["message"] !== "string" ||
      Object.hasOwn(value, "result")
    ) {
      this.#failProtocol("Native data core error response is malformed");
      return;
    }
    pending.cleanup?.();
    this.#pending.delete(id);
    const safeCode = /^[a-zA-Z0-9_.-]{1,128}$/u.test(error["code"])
      ? error["code"]
      : "remote";
    pending.reject(
      new NativeRustCoreError(
        "remote",
        `Native data core request failed (${safeCode})`,
        safeCode,
      ),
    );
  }

  #failProtocol(message: string): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#rejectAll(new NativeRustCoreError("protocol", message));
    this.#child.kill("SIGKILL");
  }

  #failProcess(message: string): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#rejectAll(new NativeRustCoreError("process", message));
    this.#child.kill("SIGKILL");
  }

  #rejectAll(error: NativeRustCoreError): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup?.();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exitResolved) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const exited = this.#exit.then(() => true);
    const result = await Promise.race([exited, timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }

  async #waitForPromise(
    promise: Promise<unknown>,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = promise.then(
      () => true,
      () => true,
    );
    const result = await Promise.race([settled, timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }
}
