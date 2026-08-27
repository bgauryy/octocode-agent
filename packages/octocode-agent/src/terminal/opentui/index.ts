/**
 * Native interactive terminal adapter. Toolkit-facing shapes are private to this
 * directory so agent-core contracts remain semantic and terminal-neutral.
 */
import type { UiPort, UiInteractionRequest, UiInteractionResult } from '@octocodeai/agent-core';

export type WorkingState = 'idle' | 'active' | 'cancelling' | 'failed';
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface PresentationState {
  readonly ready: boolean;
  readonly working: WorkingState;
  readonly transcript: string;
  readonly statuses: Readonly<Record<string, string>>;
  readonly notifications: readonly {
    severity: NotificationSeverity;
    message: string;
  }[];
  readonly title?: string;
  readonly editor?: string;
  readonly header?: unknown;
  readonly footer?: unknown;
  readonly widget?: unknown;
}

export type PresentationEvent =
  | { type: 'runtime-ready' }
  | { type: 'runtime-stopping' }
  | { type: 'runtime-failed' }
  | { type: 'message-delta'; text: string }
  | { type: 'status-changed'; name: string; text?: string }
  | { type: 'notification'; severity: NotificationSeverity; message: string }
  | {
      type: 'presentation-changed';
      property: 'title' | 'editor' | 'working' | 'header' | 'footer' | 'widget';
      value: unknown;
    };

/** Private renderer facade; concrete OpenTUI values never leave this module. */
interface OpenTuiRendererFacade {
  render(state: PresentationState): void;
  destroy(): void | Promise<void>;
}

export interface OpenTuiTerminalDependencies {
  createRenderer: () => Promise<OpenTuiRendererFacade>;
}

export interface OpenTuiTerminal {
  start(): Promise<void>;
  accept(event: PresentationEvent): void;
  stop(): Promise<void>;
  snapshot(): PresentationState;
}

export function createInitialPresentationState(): PresentationState {
  return {
    ready: false,
    working: 'idle',
    transcript: '',
    statuses: {},
    notifications: [],
  };
}

export function reducePresentation(
  state: PresentationState,
  event: PresentationEvent,
): PresentationState {
  switch (event.type) {
    case 'runtime-ready':
      return { ...state, ready: true, working: 'active' };
    case 'runtime-stopping':
      return { ...state, working: 'cancelling' };
    case 'runtime-failed':
      return { ...state, working: 'failed' };
    case 'message-delta':
      return { ...state, transcript: state.transcript + event.text };
    case 'notification':
      return {
        ...state,
        notifications: [
          ...state.notifications,
          { severity: event.severity, message: event.message },
        ],
      };
    case 'status-changed': {
      const statuses = { ...state.statuses };
      if (event.text == null) delete statuses[event.name];
      else statuses[event.name] = event.text;
      return { ...state, statuses };
    }
    case 'presentation-changed': {
      if (event.property === 'working') {
        const working = event.value;
        return working === 'idle' || working === 'active' || working === 'cancelling' || working === 'failed'
          ? { ...state, working }
          : state;
      }
      if (event.property === 'title' || event.property === 'editor') {
        return typeof event.value === 'string'
          ? { ...state, [event.property]: event.value }
          : state;
      }
      return { ...state, [event.property]: event.value };
    }
  }
}

export function createOpenTuiTerminal(
  dependencies: OpenTuiTerminalDependencies,
): OpenTuiTerminal {
  let state = createInitialPresentationState();
  let renderer: OpenTuiRendererFacade | undefined;
  let destroyPromise: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    if (destroyPromise) return destroyPromise;
    const current = renderer;
    renderer = undefined;
    destroyPromise = Promise.resolve(current?.destroy()).then(() => undefined);
    return destroyPromise;
  };

  return {
    async start() {
      if (renderer) return;
      if (destroyPromise) throw new Error('OpenTUI terminal has already stopped');
      renderer = await dependencies.createRenderer();
    },
    accept(event) {
      if (!renderer) throw new Error('OpenTUI terminal is not started');
      state = reducePresentation(state, event);
      try {
        renderer.render(state);
      } catch (error) {
        void stop();
        throw error;
      }
    },
    stop,
    snapshot() {
      return state;
    },
  };
}

export type OpenTuiInteractionHandler = (
  request: UiInteractionRequest,
  signal: AbortSignal,
) => Promise<UiInteractionResult>;

/** Map the canonical semantic UI port onto the native terminal projection. */
export function createOpenTuiUiPort(
  terminal: OpenTuiTerminal,
  interact: OpenTuiInteractionHandler = async () => ({ status: 'unsupported' }),
): UiPort {
  return {
    interact,
    async notify(message, severity) {
      terminal.accept({ type: 'notification', message, severity });
    },
    async setStatus(slot, text) {
      terminal.accept({ type: 'status-changed', name: slot, text });
    },
    async present(command) {
      terminal.accept({
        type: 'presentation-changed',
        property: command.type,
        value: command.value,
      });
    },
  };
}
