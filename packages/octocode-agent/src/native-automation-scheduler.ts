import {
  RuntimeFailure,
  type AutomationCandidate,
  type AutomationClaim,
  type AutomationDefinition,
  type AutomationJson,
  type AutomationStorePort,
} from "@octocodeai/agent-core";
import { Cron } from "croner";

export interface NativeAutomationSemanticExecutor {
  execute(input: {
    readonly definition: AutomationDefinition;
    readonly claim: AutomationClaim;
    readonly signal: AbortSignal;
  }): Promise<AutomationJson>;
}

export type NativeAutomationExecutorRegistry = ReadonlyMap<
  string,
  NativeAutomationSemanticExecutor
>;

export interface NativeAutomationSchedulerOptions {
  readonly store: AutomationStorePort;
  readonly ownerId: string;
  readonly executors: NativeAutomationExecutorRegistry;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly maxCatchUp?: number;
}

export interface NativeAutomationExpansionWindow {
  readonly after: number;
  readonly now: number;
  readonly restart: boolean;
  readonly maxCatchUp: number;
}

export class NativeAutomationUncertainError extends Error {
  override name = "NativeAutomationUncertainError";
}

const MAX_TIMER_MS = 86_400_000;
const MAX_CANDIDATES = 100;

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RuntimeFailure("validation", `${name} is invalid`);
  return value;
}

function executorKey(definition: AutomationDefinition): string {
  return `${definition.action.name}@${definition.action.version}`;
}

function intervalTimes(
  anchorAt: number,
  everyMs: number,
  after: number,
  now: number,
  maximum: number,
): readonly number[] {
  if (anchorAt > now) return [];
  const firstIndex = Math.max(0, Math.floor((after - anchorAt) / everyMs) + 1);
  const lastIndex = Math.floor((now - anchorAt) / everyMs);
  if (lastIndex < firstIndex) return [];
  const count = Math.min(maximum, lastIndex - firstIndex + 1);
  const selectedFirst = lastIndex - count + 1;
  return Array.from(
    { length: count },
    (_unused, index) => anchorAt + (selectedFirst + index) * everyMs,
  );
}

function cronTimes(
  expression: string,
  timeZone: string,
  after: number,
  now: number,
  maximum: number,
): readonly number[] {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    const reference = new Date(now + 1_000);
    if (!Number.isFinite(reference.getTime())) throw new RangeError("date range");
    const cron = new Cron(expression, { timezone: timeZone, paused: true });
    return cron
      .previousRuns(maximum + 32, reference)
      .filter((date) => cron.match(date))
      .map((date) => date.getTime())
      .filter((scheduledAt) => scheduledAt > after && scheduledAt <= now)
      .slice(0, maximum)
      .reverse();
  } catch {
    throw new RuntimeFailure(
      "validation",
      "Automation cron expression or timezone is invalid",
      "unsafe",
      true,
      "public",
    );
  }
}

/**
 * Expand only host-computable schedules. Cron deliberately fails closed until
 * a direct timezone-aware parser dependency is selected and reviewed.
 */
export function expandNativeAutomationCandidates(
  definition: AutomationDefinition,
  window: NativeAutomationExpansionWindow,
): readonly AutomationCandidate[] {
  const after = boundedInteger(window.after, "Automation expansion cursor", 0);
  const now = boundedInteger(window.now, "Automation expansion time", 0);
  const maxCatchUp = boundedInteger(
    window.maxCatchUp,
    "Automation catch-up limit",
    1,
    MAX_CANDIDATES,
  );
  if (now < after)
    throw new RuntimeFailure(
      "validation",
      "Automation expansion time precedes its cursor",
    );
  if (definition.state !== "active") return [];
  const due =
    definition.schedule.kind === "once"
      ? definition.schedule.at > after && definition.schedule.at <= now
        ? [definition.schedule.at]
        : []
      : definition.schedule.kind === "interval"
        ? intervalTimes(
            definition.schedule.anchorAt,
            definition.schedule.everyMs,
            after,
            now,
            maxCatchUp,
          )
        : cronTimes(
            definition.schedule.expression,
            definition.schedule.timeZone,
            after,
            now,
            maxCatchUp,
          );
  if (due.length === 0) return [];
  if (window.restart && definition.misfirePolicy === "skip") return [];
  const selected =
    definition.misfirePolicy === "catch-up" ? due : [due[due.length - 1]!];
  return selected.map((scheduledAt) => ({
    automationId: definition.id,
    scheduledAt,
  }));
}

function isAutomationJson(
  value: unknown,
  seen = new Set<object>(),
): value is AutomationJson {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isAutomationJson(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isAutomationJson(item, seen));
  seen.delete(value);
  return valid;
}

/** Session-owned polling and semantic execution over the durable store. */
export class NativeAutomationScheduler {
  readonly #store: AutomationStorePort;
  readonly #ownerId: string;
  readonly #executors: NativeAutomationExecutorRegistry;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #maxCatchUp: number;
  readonly #seenRevisions = new Map<string, number>();
  readonly #active = new Map<
    string,
    { readonly controller: AbortController; readonly completion: Promise<void> }
  >();
  #lastPollAt: number | undefined;
  #polling: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: NativeAutomationSchedulerOptions) {
    if (!options.ownerId.trim() || options.ownerId.includes("\0"))
      throw new RuntimeFailure("validation", "Automation ownerId is invalid");
    this.#store = options.store;
    this.#ownerId = options.ownerId;
    this.#executors = options.executors;
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMs = boundedInteger(
      options.pollIntervalMs ?? 1_000,
      "Automation poll interval",
      1,
      MAX_TIMER_MS,
    );
    this.#leaseMs = boundedInteger(
      options.leaseMs ?? 30_000,
      "Automation lease",
      1,
      MAX_TIMER_MS,
    );
    this.#heartbeatMs = boundedInteger(
      options.heartbeatMs ?? Math.max(1, Math.floor(this.#leaseMs / 3)),
      "Automation heartbeat",
      1,
      this.#leaseMs,
    );
    this.#maxCatchUp = boundedInteger(
      options.maxCatchUp ?? 10,
      "Automation catch-up limit",
      1,
      MAX_CANDIDATES,
    );
  }

  start(): void {
    if (this.#stopped)
      throw new RuntimeFailure("cancelled", "Automation scheduler is stopped");
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(
      () => void this.poll().catch(() => undefined),
      this.#pollIntervalMs,
    );
    this.#timer.unref?.();
    void this.poll().catch(() => undefined);
  }

  async stop(reason = "session stopped"): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const { controller } of this.#active.values())
      controller.abort(reason);
    await Promise.allSettled(
      [...this.#active.values()].map(({ completion }) => completion),
    );
  }

  async list(): Promise<readonly AutomationDefinition[]> {
    return this.#store.list();
  }

  async cancel(
    id: string,
    expectedRevision: number,
  ): Promise<AutomationDefinition> {
    return this.#store.cancel(id, expectedRevision, this.#time());
  }

  async run(id: string): Promise<void> {
    this.#assertRunning();
    const definitions = await this.#store.list({ states: ["active"] });
    const selected = definitions.find((definition) => definition.id === id);
    if (selected === undefined)
      throw new RuntimeFailure("validation", "Active automation was not found");
    const now = this.#time();
    const claims = await this.#store.claim({
      ownerId: this.#ownerId,
      now,
      leaseMs: this.#leaseMs,
      limit: 1,
      candidates: [{ automationId: id, scheduledAt: now }],
    });
    await Promise.all(claims.map((claim) => this.#execute(selected, claim)));
  }

  poll(): Promise<void> {
    this.#assertRunning();
    if (this.#polling !== undefined) return this.#polling;
    const polling = this.#pollOnce().finally(() => {
      if (this.#polling === polling) this.#polling = undefined;
    });
    this.#polling = polling;
    return polling;
  }

  async #pollOnce(): Promise<void> {
    const now = this.#time();
    const definitions = await this.#store.list({ states: ["active"] });
    const byId = new Map(
      definitions.map((definition) => [definition.id, definition]),
    );
    const candidates = definitions.flatMap((definition) => {
      const priorRevision = this.#seenRevisions.get(definition.id);
      const restart =
        priorRevision === undefined || priorRevision !== definition.revision;
      const after = restart ? definition.updatedAt : (this.#lastPollAt ?? now);
      this.#seenRevisions.set(definition.id, definition.revision);
      return expandNativeAutomationCandidates(definition, {
        after,
        now,
        restart,
        maxCatchUp: this.#maxCatchUp,
      });
    });
    this.#lastPollAt = now;
    if (candidates.length === 0) return;
    const bounded = candidates.slice(-MAX_CANDIDATES);
    const claims = await this.#store.claim({
      ownerId: this.#ownerId,
      now,
      leaseMs: this.#leaseMs,
      limit: bounded.length,
      candidates: bounded,
    });
    await Promise.all(
      claims.map((claim) => {
        const definition = byId.get(claim.automationId);
        if (definition === undefined)
          return this.#store
            .uncertain(claim, {
              state: "uncertain",
              completedAt: this.#time(),
              reason: "definition disappeared after durable admission",
            })
            .then(() => undefined);
        return this.#execute(definition, claim);
      }),
    );
  }

  #execute(
    definition: AutomationDefinition,
    claim: AutomationClaim,
  ): Promise<void> {
    const existing = this.#active.get(claim.runId);
    if (existing !== undefined) return existing.completion;
    const controller = new AbortController();
    const completion = this.#executeOwned(
      definition,
      claim,
      controller,
    ).finally(() => this.#active.delete(claim.runId));
    this.#active.set(claim.runId, { controller, completion });
    return completion;
  }

  async #executeOwned(
    definition: AutomationDefinition,
    initialClaim: AutomationClaim,
    controller: AbortController,
  ): Promise<void> {
    let claim = initialClaim;
    let heartbeatFailure = false;
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning || controller.signal.aborted) return;
      heartbeatRunning = true;
      void this.#store
        .heartbeat(claim, this.#time(), this.#leaseMs)
        .then((refreshed) => {
          claim = refreshed;
        })
        .catch(() => {
          heartbeatFailure = true;
          controller.abort("automation lease heartbeat failed");
        })
        .finally(() => {
          heartbeatRunning = false;
        });
    }, this.#heartbeatMs);
    heartbeat.unref?.();
    try {
      const executor = this.#executors.get(executorKey(definition));
      if (executor === undefined) {
        await this.#store.fail(claim, {
          state: "failed",
          completedAt: this.#time(),
          error: {
            code: "unsupported-action",
            message: "No semantic automation executor is registered",
            retryable: false,
          },
        });
        return;
      }
      let result: AutomationJson;
      try {
        result = await executor.execute({
          definition,
          claim,
          signal: controller.signal,
        });
        if (!isAutomationJson(result))
          throw new Error("executor returned non-JSON data");
      } catch (error) {
        if (
          error instanceof NativeAutomationUncertainError ||
          controller.signal.aborted ||
          heartbeatFailure
        ) {
          await this.#store.uncertain(claim, {
            state: "uncertain",
            completedAt: this.#time(),
            reason: "automation effect completion is uncertain",
          });
        } else {
          await this.#store.fail(claim, {
            state: "failed",
            completedAt: this.#time(),
            error: {
              code: "executor-failed",
              message: "Semantic automation executor failed",
              retryable: true,
            },
          });
        }
        return;
      }
      try {
        await this.#store.complete(claim, {
          state: "succeeded",
          completedAt: this.#time(),
          result,
        });
      } catch {
        await this.#store.uncertain(claim, {
          state: "uncertain",
          completedAt: this.#time(),
          reason: "automation completion receipt is uncertain",
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  #time(): number {
    return boundedInteger(this.#now(), "Automation clock", 0);
  }

  #assertRunning(): void {
    if (this.#stopped)
      throw new RuntimeFailure("cancelled", "Automation scheduler is stopped");
  }
}
