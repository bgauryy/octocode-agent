import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
  runtimeUserInputAttachments,
  runtimeUserInputFromText,
  runtimeUserInputText,
  type AgentRuntime,
  type ModelMessage,
  type RuntimeEvent,
  type RuntimeUserInputV1,
} from '@octocodeai/agent-core';

import { handleNativeSlashCommand, type NativeSkillSummary } from './native-slash-commands.js';
import type { NativeInteractionBroker } from './native-interactions.js';
import type { RuntimePlanSnapshot } from './native-plan.js';
import type { NativeSettingsPageController } from './native-settings-page.js';
import type { NativeWorkerOperationsController } from './native-worker-operations.js';
import { presentationEvents, presentationEventsForHistory } from './native-runtime-presentation.js';
import type {
  NativeInteractivePresentationPort,
  NativePresentationChromeUpdate,
} from './presentation/contracts.js';

export interface NativeSignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void;
}

export interface NativeInteractiveControllerOptions {
  readonly runtime: AgentRuntime;
  readonly terminal: NativeInteractivePresentationPort;
  readonly interactions: NativeInteractionBroker;
  readonly input: Readable;
  readonly initialMessage?: string;
  readonly resumedMessages?: readonly ModelMessage[];
  readonly subscribeResumedMessages?: (
    listener: (messages: readonly ModelMessage[]) => void,
  ) => () => void;
  readonly subscribeSupplementalRuntimeEvents?: (
    listener: (event: RuntimeEvent) => void,
  ) => () => void;
  readonly createLineReader?: (input: Readable) => AsyncIterable<string>;
  readonly currentPlan?: () => RuntimePlanSnapshot | undefined;
  readonly skills?: () => readonly NativeSkillSummary[];
  readonly signalSource?: NativeSignalSource;
  readonly settingsPage?: NativeSettingsPageController;
  readonly thinkingSupported?: boolean;
  readonly contextLimit?: number;
  readonly permissionMode?: "strict" | "default" | "allow-all";
  readonly version?: string;
  readonly workerOperations?: Pick<NativeWorkerOperationsController, 'open' | 'dispatch'>;
}

/** Owns one interactive runtime/terminal session and its complete teardown. */
export async function runNativeInteractiveController(
  options: NativeInteractiveControllerOptions,
): Promise<number> {
  const {
    runtime,
    terminal,
    interactions,
    input,
    initialMessage,
    resumedMessages = [],
    currentPlan = () => undefined,
    skills = () => [],
    signalSource = process,
    settingsPage,
    thinkingSupported = false,
    contextLimit,
    permissionMode,
    version,
  } = options;
  const createLineReader = options.createLineReader
    ?? ((stream: Readable) => createInterface({ input: stream, crlfDelay: Infinity }));
  try {
    await terminal.start();
  } catch (startupFailure) {
    await Promise.allSettled([
      Promise.resolve().then(() => runtime.stop()),
      Promise.resolve().then(() => settingsPage?.close()),
      Promise.resolve().then(() => terminal.stop()),
    ]);
    throw startupFailure;
  }
  let detachInteractions: () => void = () => undefined;
  let activeTurnId: string | undefined;
  let submissionInFlight = false;
  let submissionFailure: unknown;
  const submissions = new Set<Promise<void>>();
  const submit = (input: string | RuntimeUserInputV1): void => {
    submissionInFlight = true;
    terminal.accept({ type: 'presentation-changed', property: 'working', value: 'active' });
    const task = runtime.submit(input)
      .catch((error) => { submissionFailure ??= error; })
      .finally(() => {
        submissionInFlight = false;
        if (runtime.snapshot().state !== 'running' && activeTurnId === undefined
          && terminal.snapshot()?.working === 'active') {
          terminal.accept({ type: 'presentation-changed', property: 'working', value: 'idle' });
        }
      });
    submissions.add(task);
    void task.finally(() => submissions.delete(task));
  };
  let followUps = Promise.resolve();
  const followUp = (input: string | RuntimeUserInputV1): void => {
    const task = followUps.then(async () => {
      const result = await runtime.execute(typeof input === 'string'
        ? { type: 'input.follow-up', text: input }
        : { type: 'input.follow-up', input });
      if (!result.ok) terminal.accept({
        type: 'notification',
        severity: 'error',
        message: `Follow-up rejected · ${result.error.message}`,
      });
    }).catch((error) => { submissionFailure ??= error; });
    followUps = task;
    submissions.add(task);
    void task.finally(() => submissions.delete(task));
  };
  let presentedChrome: NativePresentationChromeUpdate | undefined;
  const presentChromeFacts = (trust: 'trusted' | 'untrusted' | 'unknown'): void => {
    const snapshot = runtime.snapshot();
    const chrome: NativePresentationChromeUpdate = {
      authority: 'runtime', title: 'Octocode Agent',
      ...(snapshot.model?.modelId === undefined ? {} : { modelId: snapshot.model.modelId }),
      ...(snapshot.sessionId === undefined ? {} : { sessionId: String(snapshot.sessionId) }),
      ...(version === undefined ? {} : { version }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      trust,
    };
    if (presentedChrome !== undefined
      && presentedChrome.title === chrome.title
      && presentedChrome.modelId === chrome.modelId
      && presentedChrome.sessionId === chrome.sessionId
      && presentedChrome.version === chrome.version
      && presentedChrome.permissionMode === chrome.permissionMode
      && presentedChrome.trust === chrome.trust) return;
    presentedChrome = chrome;
    terminal.accept({ type: 'chrome-changed', chrome });
  };
  const interactionHandler = terminal.interact === undefined
    ? async () => ({ status: 'unsupported' as const })
    : (...args: Parameters<NonNullable<NativeInteractivePresentationPort['interact']>>) => terminal.interact!(...args);
  detachInteractions = interactions.attach(interactionHandler);
  terminal.accept({ type: 'interaction-handler-state', ready: terminal.interact !== undefined });
  const presentRuntimeEvent = (event: RuntimeEvent): void => {
    presentChromeFacts(event.trust.workspace);
    if (event.type === 'turn.started') activeTurnId = event.payload.turnId;
    for (const semantic of presentationEvents(event, activeTurnId, { contextLimit })) terminal.accept(semantic);
    if (event.type === 'turn.ended') activeTurnId = undefined;
  };
  const unsubscribe = runtime.subscribe(presentRuntimeEvent);
  const detachSupplementalRuntimeEvents =
    options.subscribeSupplementalRuntimeEvents?.(presentRuntimeEvent)
    ?? (() => undefined);
  let detachInput: (() => void) | undefined;
  let detachFailure: (() => void) | undefined;
  let detachSignals: (() => void) | undefined;
  let detachResumedMessages: (() => void) | undefined;
  try {
    presentChromeFacts('unknown');
    for (const semantic of presentationEventsForHistory(resumedMessages)) terminal.accept(semantic);
    detachResumedMessages = options.subscribeResumedMessages?.((messages) => {
      terminal.accept({ type: 'transcript-cleared' });
      for (const semantic of presentationEventsForHistory(messages)) terminal.accept(semantic);
    });
    await runtime.start();
    if (initialMessage) submit(initialMessage);
    let finishNativeInput: (() => void) | undefined;
    const nativeInputDone = new Promise<void>((resolve) => { finishNativeInput = resolve; });
    detachFailure = terminal.subscribeFailure?.((error) => {
      submissionFailure ??= error;
      finishNativeInput?.();
    });
    const handleInput = async (input: RuntimeUserInputV1): Promise<boolean> => {
      const text = runtimeUserInputText(input);
      const attachments = runtimeUserInputAttachments(input);
      if (attachments.length === 0 && terminal.acceptInput?.(text)) return true;
      const command = attachments.length === 0
        ? await handleNativeSlashCommand(text, {
        runtime,
        terminal,
        currentPlan,
        skills,
        thinkingSupported,
        ...(options.workerOperations === undefined ? {} : { workerOperations: options.workerOperations }),
        onContextCleared: () => {
          terminal.accept({ type: 'context-cleared' });
          presentChromeFacts(presentedChrome?.trust ?? 'unknown');
        },
        ...(settingsPage ? { openSettings: (section) => settingsPage.open(section) } : {}),
          })
        : 'unhandled';
      if (command === 'exit') return false;
      if (command === 'handled') return true;
      if (text.trim() || attachments.length > 0) {
        const runtimeActive = runtime.snapshot().state === 'running';
        const submittedInput = attachments.length === 0 ? text : input;
        if (!submissionInFlight && activeTurnId === undefined && !runtimeActive) submit(submittedInput);
        else followUp(submittedInput);
      }
      return true;
    };
    const handleLine = async (line: string): Promise<boolean> =>
      line.trim().length === 0 ? true : handleInput(runtimeUserInputFromText(line));
    if (terminal.inputOwnership === 'renderer') {
      if (!terminal.subscribeInput) throw new Error('renderer-owned input requires a terminal input subscription');
      const settleSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
        void (async () => {
          try {
            const active = runtime.snapshot().state === 'running' || activeTurnId !== undefined || submissionInFlight;
            if (active) await runtime.cancel(signal === 'SIGTERM' ? 'process terminated' : 'user interrupt');
            if (signal === 'SIGTERM' || !active) finishNativeInput?.();
          } catch (error) {
            submissionFailure ??= error;
            finishNativeInput?.();
          }
        })();
      };
      const onSigint = () => settleSignal('SIGINT');
      const onSigterm = () => settleSignal('SIGTERM');
      signalSource.on('SIGINT', onSigint);
      signalSource.on('SIGTERM', onSigterm);
      detachSignals = () => {
        signalSource.off('SIGINT', onSigint);
        signalSource.off('SIGTERM', onSigterm);
      };
      detachInput = terminal.subscribeInput(async (event) => {
        if (event.type === 'line') {
          if (!await handleLine(event.line)) finishNativeInput?.();
          return;
        }
        if (event.type === 'input') {
          if (!await handleInput(event.input)) finishNativeInput?.();
          return;
        }
        if (terminal.cancelInteraction?.()) return;
        if (runtime.snapshot().state === 'running' || activeTurnId !== undefined || submissionInFlight) {
          await runtime.cancel('user interrupt');
        } else {
          finishNativeInput?.();
        }
      });
      await nativeInputDone;
    } else {
      for await (const line of createLineReader(input)) {
        if (!await handleLine(line)) break;
      }
    }
    return 0;
  } finally {
    detachResumedMessages?.();
    let failure: unknown;
    try { await runtime.stop(); }
    catch (error) { failure = error; }
    finally {
      await Promise.allSettled([...submissions]);
      failure ??= submissionFailure;
      unsubscribe();
      detachSupplementalRuntimeEvents();
      detachInput?.();
      detachFailure?.();
      detachSignals?.();
      detachInteractions();
      try { await settingsPage?.close(); }
      catch (error) { failure ??= error; }
      try { await terminal.stop(); }
      catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }
}
