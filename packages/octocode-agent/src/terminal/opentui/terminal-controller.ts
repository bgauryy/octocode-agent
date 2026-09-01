import type {
  UiInteractionRequest,
  UiInteractionResult,
} from "@octocodeai/agent-core";
import type {
  NativePresentationInputEvent,
  NativePresentationInteractionRequest,
} from "../../presentation/contracts.js";
import { parseNativePresentationInteractionRequest } from "../../presentation/contracts.js";

import type {
  OpenTuiRendererEvents,
  OpenTuiRendererFacade,
  OpenTuiTerminal,
  OpenTuiTerminalDependencies,
  PresentationEvent,
  PresentationState,
} from "./presentation.js";
import type { OpenTuiStore } from "./state/view-store.js";

interface PendingInteraction {
  readonly generation: number;
  readonly request: NativePresentationInteractionRequest;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: (result: UiInteractionResult) => void;
}

function presentationInteractionRequest(
  request: UiInteractionRequest,
): NativePresentationInteractionRequest | undefined {
  if (request.type === "custom") return undefined;
  const workflow = request.workflow === undefined ? {} : { workflow: request.workflow };
  let candidate: unknown;
  switch (request.type) {
    case "confirm":
      candidate = { type: "confirm", message: request.message, ...workflow };
      break;
    case "select":
      candidate = { type: "select", message: request.message, options: request.options, ...workflow };
      break;
    case "input":
      candidate = {
        type: "input",
        message: request.message,
        ...workflow,
        ...(request.initial === undefined ? {} : { initial: request.initial }),
      };
      break;
    case "editor":
      candidate = {
        type: "editor",
        message: request.message,
        initial: request.initial,
        ...workflow,
      };
      break;
  }
  return parseNativePresentationInteractionRequest(candidate);
}

function abortedInteractionResult(reason: unknown): UiInteractionResult {
  return typeof reason === "string" && reason.toLowerCase().includes("timeout")
    ? { status: "timeout" }
    : { status: "cancelled" };
}

/**
 * Stateful terminal lifecycle boundary. Presentation state remains in Zustand;
 * this controller owns renderer startup/teardown, ordered input delivery, and
 * exactly one generation-scoped pending interaction.
 */
export class OpenTuiTerminalController implements OpenTuiTerminal {
  readonly inputOwnership: OpenTuiTerminal["inputOwnership"];

  private renderer?: OpenTuiRendererFacade;
  private unsubscribe?: () => void;
  private startPromise?: Promise<void>;
  private destroyPromise?: Promise<void>;
  private stopping = false;
  private inputQueue = Promise.resolve();
  private pendingRender?: PresentationState;
  private renderScheduled = false;
  private readonly inputListeners = new Set<
    (event: NativePresentationInputEvent) => void | Promise<void>
  >();
  private readonly failureListeners = new Set<(error: unknown) => void>();
  private pendingInteraction?: PendingInteraction;

  private readonly rendererEvents: OpenTuiRendererEvents = {
    submitInput: (input) => this.enqueueInput({ type: "input", input }),
    inputValidation: (message) => {
      this.store.getState().actions.accept({
        type: "notification",
        severity: "error",
        message,
      });
    },
    resolveInteraction: (generation, result) => {
      queueMicrotask(() => {
        this.settleInteraction(generation, result);
      });
    },
    interrupt: () => {
      queueMicrotask(() => {
        const pending = this.pendingInteraction;
        if (
          pending &&
          this.settleInteraction(pending.generation, { status: "cancelled" })
        )
          return;
        this.enqueueInput({ type: "interrupt" });
      });
    },
    failure: (error) => {
      this.reportFailure(error);
      void this.stop();
    },
  };

  constructor(
    private readonly dependencies: OpenTuiTerminalDependencies<OpenTuiStore>,
    private readonly store: OpenTuiStore,
  ) {
    this.inputOwnership = dependencies.inputOwnership ?? "external";
  }

  async start(): Promise<void> {
    if (this.renderer) return;
    if (this.destroyPromise)
      throw new Error("OpenTUI terminal has already stopped");
    this.startPromise ??= this.dependencies
      .createRenderer(this.rendererEvents, this.store)
      .then(async (created) => {
        if (this.stopping) {
          await created.destroy();
          return;
        }
        this.renderer = created;
        this.unsubscribe = this.store.subscribe((state, previous) => {
          if (state.presentation === previous.presentation) return;
          this.scheduleRender(state.presentation);
        });
      });
    await this.startPromise;
  }

  accept(event: PresentationEvent): void {
    if (this.destroyPromise)
      throw new Error("OpenTUI terminal has already stopped");
    this.store.getState().actions.accept(event);
  }

  interact(
    request: UiInteractionRequest,
    signal: AbortSignal,
  ): Promise<UiInteractionResult> {
    if (this.destroyPromise) return Promise.resolve({ status: "unsupported" });
    const presentationRequest = presentationInteractionRequest(request);
    if (presentationRequest === undefined)
      return Promise.resolve({ status: "unsupported" });
    if (signal.aborted)
      return Promise.resolve(abortedInteractionResult(signal.reason));
    return new Promise<UiInteractionResult>((resolve) => {
      if (this.pendingInteraction) {
        this.settleInteraction(this.pendingInteraction.generation, {
          status: "cancelled",
        });
      }
      this.store
        .getState()
        .actions.accept({
          type: "interaction-requested",
          request: presentationRequest,
        });
      const generation =
        this.store.getState().presentation.interaction?.generation;
      if (generation === undefined) {
        resolve({ status: "unsupported" });
        return;
      }
      const onAbort = () =>
        this.settleInteraction(
          generation,
          abortedInteractionResult(signal.reason),
        );
      this.pendingInteraction = {
        generation,
        request: presentationRequest,
        signal,
        onAbort,
        resolve,
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  acceptInput(line: string): boolean {
    const pending = this.pendingInteraction;
    if (pending === undefined) return false;
    const value = line.trim();
    if (value === "/cancel") {
      this.settleInteraction(pending.generation, { status: "cancelled" });
      return true;
    }
    if (value === "/discuss" && pending.request.workflow?.allowDiscuss === true) {
      this.settleInteraction(pending.generation, { status: "discuss" });
      return true;
    }
    switch (pending.request.type) {
      case "confirm": {
        const answer = value.toLowerCase();
        if (answer === "yes" || answer === "y") {
          this.settleInteraction(pending.generation, {
            status: "accepted",
            value: true,
          });
        } else if (answer === "no" || answer === "n") {
          this.settleInteraction(pending.generation, {
            status: "accepted",
            value: false,
          });
        } else {
          this.store
            .getState()
            .actions.accept({
              type: "interaction-validation",
              message: "Enter yes or no.",
            });
        }
        return true;
      }
      case "select": {
        const numeric = /^\d+$/.test(value) ? Number(value) - 1 : -1;
        const selected =
          numeric >= 0 && numeric < pending.request.options.length
            ? pending.request.options[numeric]
            : pending.request.options.find((option) => option === line);
        if (selected === undefined)
          this.store.getState().actions.accept({
            type: "interaction-validation",
            message: `Choose 1-${pending.request.options.length} or enter an exact option.`,
          });
        else
          this.settleInteraction(pending.generation, {
            status: "accepted",
            value: selected,
          });
        return true;
      }
      case "input":
      case "editor":
        this.settleInteraction(pending.generation, {
          status: "accepted",
          value: line,
        });
        return true;
    }
  }

  subscribeInput(
    listener: (event: NativePresentationInputEvent) => void | Promise<void>,
  ): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  subscribeFailure(listener: (error: unknown) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  cancelInteraction(): boolean {
    const pending = this.pendingInteraction;
    return pending === undefined
      ? false
      : this.settleInteraction(pending.generation, { status: "cancelled" });
  }

  stop(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.stopping = true;
    if (this.pendingInteraction) {
      this.settleInteraction(this.pendingInteraction.generation, {
        status: "cancelled",
      });
    }
    this.destroyPromise = (async () => {
      try {
        await this.startPromise;
      } catch {
        /* initialization already failed */
      }
      this.flushPendingRender();
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.inputListeners.clear();
      this.pendingRender = undefined;
      const current = this.renderer;
      this.renderer = undefined;
      await current?.destroy();
    })();
    return this.destroyPromise;
  }

  snapshot(): PresentationState {
    return this.store.getState().presentation;
  }

  private settleInteraction(
    generation: number,
    result: UiInteractionResult,
  ): boolean {
    const pending = this.pendingInteraction;
    if (pending === undefined || pending.generation !== generation)
      return false;
    const normalizedResult =
      result.status === "accepted" &&
      pending.request.type === "select" &&
      typeof result.value === "string" &&
      /^choice-\d+$/u.test(result.value)
        ? {
            status: "accepted" as const,
            value:
              pending.request.options[
                Number(result.value.slice("choice-".length)) - 1
              ] ?? result.value,
          }
        : result;
    this.pendingInteraction = undefined;
    pending.signal.removeEventListener("abort", pending.onAbort);
    if (
      normalizedResult.status === "accepted" &&
      (typeof normalizedResult.value === "string" ||
        typeof normalizedResult.value === "boolean")
    ) {
      this.store.getState().actions.accept({
        type: "interaction-resolved",
        result: { status: "accepted", value: normalizedResult.value },
      });
    } else {
      const status =
        normalizedResult.status === "accepted"
          ? "unsupported"
          : normalizedResult.status;
      this.store
        .getState()
        .actions.accept({ type: "interaction-resolved", result: { status } });
    }
    pending.resolve(normalizedResult);
    return true;
  }

  private enqueueInput(event: NativePresentationInputEvent): void {
    this.inputQueue = this.inputQueue
      .then(async () => {
        for (const listener of [...this.inputListeners]) await listener(event);
      })
      .catch((error: unknown) => {
        this.reportFailure(error);
        void this.stop();
      });
  }

  private scheduleRender(presentation: PresentationState): void {
    this.pendingRender = presentation;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      if (!this.stopping) this.flushPendingRender();
    });
  }

  private flushPendingRender(): void {
    const pending = this.pendingRender;
    this.pendingRender = undefined;
    if (pending === undefined || this.renderer === undefined) return;
    try {
      this.renderer.render(pending);
    } catch (error) {
      this.reportFailure(error);
      if (!this.stopping) void this.stop();
    }
  }

  private reportFailure(error: unknown): void {
    for (const listener of [...this.failureListeners]) {
      try {
        listener(error);
      } catch {
        /* Failure observers cannot hide the original failure. */
      }
    }
  }
}
