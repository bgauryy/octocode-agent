export type ErrorCategory =
  | 'validation' | 'protocol' | 'unsupported-version' | 'unsupported-capability'
  | 'trust' | 'approval' | 'plan-policy' | 'peer-lock' | 'cancelled' | 'timeout'
  | 'provider' | 'model' | 'tool-execution' | 'session-conflict' | 'session-corruption'
  | 'session-migration' | 'persistence' | 'compaction' | 'adapter-compatibility'
  | 'adapter-translation' | 'conflict' | 'plugin' | 'internal-invariant';

export type RedactionClass = 'public' | 'sensitive' | 'secret' | 'internal';
export interface RuntimeErrorData {
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retry: 'safe' | 'unsafe' | 'unknown';
  readonly userVisible: boolean;
  readonly redaction: RedactionClass;
  readonly terminalEffect: 'none' | 'operation' | 'session' | 'runtime';
  readonly safeCause?: string;
  readonly retryAfterMs?: number;
}

export class RuntimeFailure extends Error implements RuntimeErrorData {
  override name = 'RuntimeFailure';
  constructor(
    readonly category: ErrorCategory,
    message: string,
    readonly retry: RuntimeErrorData['retry'] = 'unsafe',
    readonly userVisible = true,
    readonly redaction: RedactionClass = 'public',
    readonly terminalEffect: RuntimeErrorData['terminalEffect'] = 'operation',
    readonly safeCause?: string,
    readonly retryAfterMs?: number,
  ) { super(message); }
  toJSON(): RuntimeErrorData { return { category: this.category, message: this.message, retry: this.retry, userVisible: this.userVisible, redaction: this.redaction, terminalEffect: this.terminalEffect, ...(this.safeCause === undefined ? {} : { safeCause: this.safeCause }), ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }) }; }
}
