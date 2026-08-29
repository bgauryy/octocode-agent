export type UiInteractionRequest =
  | { readonly type: 'confirm'; readonly message: string }
  | { readonly type: 'select'; readonly message: string; readonly options: readonly string[] }
  | { readonly type: 'input'; readonly message: string; readonly initial?: string }
  | { readonly type: 'editor'; readonly initial: string }
  | { readonly type: 'custom'; readonly capability: string; readonly payload: unknown };
export type UiInteractionResult = { readonly status: 'accepted'; readonly value: unknown } | { readonly status: 'cancelled' | 'timeout' | 'unsupported' };
export interface UiPort { interact(request: UiInteractionRequest, signal: AbortSignal): Promise<UiInteractionResult>; notify(message: string, severity: 'info' | 'warning' | 'error'): Promise<void>; setStatus(slot: string, text?: string): Promise<void>; present(command: { readonly type: 'working' | 'widget'; readonly value: unknown }): Promise<void>; }
