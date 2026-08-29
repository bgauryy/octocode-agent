import { randomUUID } from 'node:crypto';
import {
  RuntimeFailure,
  sessionId,
  type AgentRuntime,
  type RuntimeCommand,
  type RuntimeCommandResult,
  type RuntimeEvent,
  type RuntimeSnapshot,
  type SessionControllerPort,
  type SessionId,
  type SessionProjection,
} from '@octocodeai/agent-core';

export type NativeSessionTransitionReason = 'initial' | 'create' | 'resume' | 'switch' | 'fork' | 'navigate';

export interface NativeSessionRuntimeFactoryInput {
  readonly sessionId: SessionId;
  readonly projection: SessionProjection;
  readonly reason: NativeSessionTransitionReason;
  readonly previousSessionId?: SessionId;
}

export interface NativeSessionRuntimeRouterOptions {
  readonly controller: SessionControllerPort;
  readonly initialSessionId: SessionId;
  readonly createRuntime: (input: NativeSessionRuntimeFactoryInput) => Promise<AgentRuntime>;
  readonly createSessionId?: () => SessionId;
  readonly resolveNavigation?: (input: {
    readonly current: SessionId;
    readonly direction: Extract<RuntimeCommand, { type: 'session.navigate' }>['direction'];
  }) => Promise<SessionId | null> | SessionId | null;
  readonly onTransition?: (transition: {
    readonly reason: NativeSessionTransitionReason;
    readonly previousSessionId: SessionId;
    readonly sessionId: SessionId;
  }) => void;
  readonly cleanupTimeoutMs?: number;
  readonly onCleanupError?: (error: unknown, sessionId: SessionId) => void;
}

/**
 * Routes session commands above immutable, fixed-session runtime kernels.
 * Every activation receives a newly constructed runtime so session persistence,
 * context, and effect-ledger state can never bleed across identities.
 */
export class NativeSessionRuntimeRouter implements AgentRuntime {
  readonly #controller: SessionControllerPort;
  readonly #createRuntime: NativeSessionRuntimeRouterOptions['createRuntime'];
  readonly #createSessionId: () => SessionId;
  readonly #resolveNavigation?: NativeSessionRuntimeRouterOptions['resolveNavigation'];
  readonly #onTransition?: NativeSessionRuntimeRouterOptions['onTransition'];
  readonly #cleanupTimeoutMs: number;
  readonly #onCleanupError?: NativeSessionRuntimeRouterOptions['onCleanupError'];
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  #active: AgentRuntime;
  #detachActive: () => void;
  #started = false;
  #transition: Promise<void> | null = null;

  constructor(options: NativeSessionRuntimeRouterOptions, active: AgentRuntime) {
    this.#controller = options.controller;
    this.#createRuntime = options.createRuntime;
    this.#createSessionId = options.createSessionId ?? (() => sessionId(randomUUID()));
    this.#resolveNavigation = options.resolveNavigation;
    this.#onTransition = options.onTransition;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
    this.#onCleanupError = options.onCleanupError;
    this.#active = active;
    this.#detachActive = this.#forward(active);
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await this.#active.start();
    this.#started = true;
  }

  async submit(input: string): Promise<void> {
    if (this.#transition !== null) throw new RuntimeFailure('conflict', 'Cannot submit while switching sessions');
    await this.#active.submit(input);
  }

  async cancel(reason?: string): Promise<void> { await this.#active.cancel(reason); }

  async execute(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (!isSessionCommand(command)) {
      if (this.#transition !== null) return failure(new RuntimeFailure('conflict', 'Runtime command cannot execute while switching sessions'));
      return this.#active.execute(command);
    }
    if (this.#transition !== null) return failure(new RuntimeFailure('conflict', 'A session transition is already active'));
    let release!: () => void;
    this.#transition = new Promise<void>((resolve) => { release = resolve; });
    try { return await this.#executeSession(command); }
    catch (error) { return failure(asFailure(error)); }
    finally { release(); this.#transition = null; }
  }

  snapshot(): RuntimeSnapshot { return this.#active.snapshot(); }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async stop(): Promise<void> {
    await this.#transition;
    this.#detachActive();
    await this.#active.stop();
  }

  async #executeSession(command: SessionRuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.type === 'session.export') return { ok: true, data: await this.#controller.export() };
    if (this.#active.snapshot().activeTurn) throw new RuntimeFailure('conflict', 'Session mutations require an idle runtime');
    if (command.type === 'session.name') {
      const projection = await this.#controller.name(command.name);
      return { ok: true, data: { sessionId: projection.sessionId, name: projection.name, projection } };
    }

    const previousSessionId = this.#active.snapshot().sessionId;
    let reason: NativeSessionTransitionReason;
    let projection: SessionProjection;
    if (command.type === 'session.create') {
      reason = 'create';
      projection = await this.#controller.create(command.id === undefined ? this.#createSessionId() : checkedId(command.id), command.name);
    } else if (command.type === 'session.resume') {
      reason = 'resume';
      projection = await this.#controller.resume(checkedId(command.id));
    } else if (command.type === 'session.switch') {
      reason = 'switch';
      projection = await this.#controller.switch(checkedId(command.id));
    } else if (command.type === 'session.fork') {
      reason = 'fork';
      projection = await this.#controller.fork(previousSessionId, checkedId(command.id));
    } else {
      if (command.type !== 'session.navigate') throw new RuntimeFailure('internal-invariant', `Unhandled session command: ${command.type}`);
      reason = 'navigate';
      if (this.#resolveNavigation === undefined) throw new RuntimeFailure('unsupported-capability', 'Session navigation requires a composed resolver');
      const target = await this.#resolveNavigation({ current: previousSessionId, direction: command.direction });
      if (target === null) throw new RuntimeFailure('unsupported-capability', `No ${command.direction} session is available`);
      projection = await this.#controller.switch(target);
    }
    if ((reason === 'resume' || reason === 'switch' || reason === 'navigate') && String(projection.revision) === '0') {
      await this.#controller.resume(previousSessionId);
      throw new RuntimeFailure('validation', `Session ${projection.sessionId} does not exist`);
    }
    return this.#replace(previousSessionId, projection, reason);
  }

  async #replace(previousSessionId: SessionId, projection: SessionProjection, reason: NativeSessionTransitionReason): Promise<RuntimeCommandResult> {
    let next: AgentRuntime | undefined;
    let detachNext: (() => void) | undefined;
    try {
      next = await this.#createRuntime({ sessionId: projection.sessionId, projection, reason, previousSessionId });
      detachNext = this.#forward(next);
      if (this.#started) await next.start();
    } catch (error) {
      detachNext?.();
      if (next !== undefined) await this.#cleanup(next);
      await this.#controller.resume(previousSessionId);
      throw error;
    }

    const previous = this.#active;
    this.#detachActive();
    this.#active = next;
    this.#detachActive = detachNext;
    await this.#cleanup(previous);
    this.#onTransition?.({ reason, previousSessionId, sessionId: projection.sessionId });
    return { ok: true, data: { sessionId: projection.sessionId, projection } };
  }

  #forward(runtime: AgentRuntime): () => void {
    return runtime.subscribe((event) => { for (const listener of this.#listeners) listener(event); });
  }

  async #cleanup(runtime: AgentRuntime): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        runtime.stop(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new RuntimeFailure('timeout', 'Old session runtime cleanup timed out')), this.#cleanupTimeoutMs);
          timeout.unref();
        }),
      ]);
    } catch (error) {
      this.#onCleanupError?.(error, runtime.snapshot().sessionId);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

export async function createNativeSessionRuntimeRouter(options: NativeSessionRuntimeRouterOptions): Promise<NativeSessionRuntimeRouter> {
  const projection = await options.controller.resume(options.initialSessionId);
  const active = await options.createRuntime({ sessionId: options.initialSessionId, projection, reason: 'initial' });
  return new NativeSessionRuntimeRouter(options, active);
}

type SessionRuntimeCommand = Extract<RuntimeCommand, { type: `session.${string}` }>;
const isSessionCommand = (command: RuntimeCommand): command is SessionRuntimeCommand => command.type.startsWith('session.');
function checkedId(value: string): SessionId {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new RuntimeFailure('validation', 'Session id must contain 1-200 characters');
  return sessionId(normalized);
}
const asFailure = (error: unknown): RuntimeFailure => error instanceof RuntimeFailure
  ? error
  : new RuntimeFailure('internal-invariant', error instanceof Error ? error.message : 'Session transition failed');
const failure = (error: RuntimeFailure): RuntimeCommandResult => ({ ok: false, error: error.toJSON() });
