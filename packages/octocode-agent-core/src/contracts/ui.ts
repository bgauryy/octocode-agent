export const MAX_UI_INTERACTION_TEXT = 8_192;
export const MAX_UI_INTERACTION_OPTIONS = 50;
export const MAX_UI_WORKFLOW_STEPS = 20;

export interface UiInteractionWorkflowStep {
  readonly workflowId: string;
  readonly questionId: string;
  readonly index: number;
  readonly total: number;
  readonly title?: string;
  readonly instructions?: string;
  readonly allowDiscuss: boolean;
}

type UiInteractionWorkflowAware = { readonly workflow?: UiInteractionWorkflowStep };

export type UiInteractionRequest =
  | ({ readonly type: 'confirm'; readonly message: string } & UiInteractionWorkflowAware)
  | ({ readonly type: 'select'; readonly message: string; readonly options: readonly string[] } & UiInteractionWorkflowAware)
  | ({ readonly type: 'input'; readonly message: string; readonly initial?: string } & UiInteractionWorkflowAware)
  | ({ readonly type: 'editor'; readonly message: string; readonly initial: string } & UiInteractionWorkflowAware)
  | { readonly type: 'custom'; readonly capability: string; readonly payload: unknown };
export type UiInteractionResult =
  | { readonly status: 'accepted'; readonly value: unknown }
  | { readonly status: 'discuss' }
  | { readonly status: 'cancelled' | 'timeout' | 'unsupported' };
export interface UiPort { interact(request: UiInteractionRequest, signal: AbortSignal): Promise<UiInteractionResult>; notify(message: string, severity: 'info' | 'warning' | 'error'): Promise<void>; setStatus(slot: string, text?: string): Promise<void>; present(command: { readonly type: 'working' | 'widget'; readonly value: unknown }): Promise<void>; }
