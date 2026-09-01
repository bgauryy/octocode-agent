/** Stable, renderer-neutral native presentation API. */

export type AgentPresentationInputOwnershipV1 = 'renderer' | 'external';

export type AgentPresentationInputEventV1 =
  | { readonly type: 'line'; readonly line: string }
  | { readonly type: 'interrupt' };

export type AgentPresentationEventV1 = Readonly<{
  readonly type: string;
  readonly [key: string]: unknown;
}>;

export interface AgentPresentationSnapshotV1 {
  readonly working: 'idle' | 'active' | 'cancelling' | 'failed';
}

export interface AgentPresentationAbortSignalV1 {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface AgentPresentationWorkflowStepV1 {
  readonly workflowId: string;
  readonly questionId: string;
  readonly index: number;
  readonly total: number;
  readonly title?: string;
  readonly instructions?: string;
  readonly allowDiscuss: boolean;
}

export type AgentPresentationInteractionRequestV1 =
  | { readonly type: 'confirm'; readonly message: string; readonly workflow?: AgentPresentationWorkflowStepV1 }
  | { readonly type: 'select'; readonly message: string; readonly options: readonly string[]; readonly workflow?: AgentPresentationWorkflowStepV1 }
  | { readonly type: 'input'; readonly message: string; readonly initial?: string; readonly workflow?: AgentPresentationWorkflowStepV1 }
  | { readonly type: 'editor'; readonly message: string; readonly initial: string; readonly workflow?: AgentPresentationWorkflowStepV1 }
  | { readonly type: 'custom'; readonly capability: string; readonly payload: unknown };

export type AgentPresentationInteractionResultV1 =
  | { readonly status: 'accepted'; readonly value: unknown }
  | { readonly status: 'discuss' | 'cancelled' | 'timeout' | 'unsupported' };

export interface AgentPresentationPortV1 {
  readonly inputOwnership: AgentPresentationInputOwnershipV1;
  start(): Promise<void>;
  accept(event: AgentPresentationEventV1): void;
  interact?(
    request: AgentPresentationInteractionRequestV1,
    signal: AgentPresentationAbortSignalV1,
  ): Promise<AgentPresentationInteractionResultV1>;
  acceptInput?(line: string): boolean;
  subscribeInput?(
    listener: (event: AgentPresentationInputEventV1) => void | Promise<void>,
  ): () => void;
  subscribeFailure?(listener: (error: unknown) => void): () => void;
  cancelInteraction?(): boolean;
  snapshot(): AgentPresentationSnapshotV1;
  stop(): Promise<void>;
}

export interface AgentPresentationFactoryContextV1 {
  readonly schemaVersion: 1;
  readonly cwd: string;
  readonly alternateOutput: boolean;
  readonly reducedMotion: boolean;
}

export type AgentPresentationFactoryV1 = (
  context: AgentPresentationFactoryContextV1,
) => AgentPresentationPortV1;
