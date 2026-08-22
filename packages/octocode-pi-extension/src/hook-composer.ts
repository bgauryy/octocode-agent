import type { PiInstance } from './types.js';

export type HookMiddleware = (...args: unknown[]) => unknown | Promise<unknown>;

export interface HookMiddlewareEntry {
  name: string;
  handler: HookMiddleware;
}

export interface HookComposerOptions {
  onError?: (error: unknown, event: string, middleware: string, args: unknown[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeHookResult(current: unknown, next: unknown): unknown {
  if (next === undefined) return current;
  if (current === undefined) return next;
  if (isRecord(current) && isRecord(next)) return { ...current, ...next };
  return next;
}

function shouldStopForBlock(event: string, result: unknown): boolean {
  return event === 'tool_call' && isRecord(result) && result.block === true;
}

function formatHookError(error: unknown, event: string, middleware: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Octocode hook ${event}/${middleware} failed: ${message}`;
}

export async function runHookMiddleware(
  event: string,
  middlewares: HookMiddlewareEntry[],
  args: unknown[],
  options: HookComposerOptions = {},
): Promise<unknown> {
  let aggregate: unknown;
  for (const middleware of middlewares) {
    try {
      const result = await middleware.handler(...args);
      aggregate = mergeHookResult(aggregate, result);
      if (shouldStopForBlock(event, aggregate)) break;
    } catch (error) {
      options.onError?.(error, event, middleware.name, args);
      if (event === 'tool_call') {
        return { block: true, reason: formatHookError(error, event, middleware.name) };
      }
    }
  }
  return aggregate;
}

export class OctocodeHookComposer {
  private readonly middlewares = new Map<string, HookMiddlewareEntry[]>();
  private readonly registeredEvents = new Set<string>();

  constructor(
    private readonly pi: PiInstance,
    private readonly options: HookComposerOptions = {},
  ) {}

  on<TArgs extends unknown[]>(event: string, name: string, handler: (...args: TArgs) => unknown | Promise<unknown>): void {
    const entries = this.middlewares.get(event) ?? [];
    entries.push({ name, handler: handler as HookMiddleware });
    this.middlewares.set(event, entries);
    if (this.registeredEvents.has(event)) return;
    this.registeredEvents.add(event);
    this.pi.on(event, async (...args: unknown[]) => {
      const result = await runHookMiddleware(event, this.middlewares.get(event) ?? [], args, this.options);
      return result;
    });
  }

  entries(event: string): HookMiddlewareEntry[] {
    return [...(this.middlewares.get(event) ?? [])];
  }
}

export function createHookComposer(pi: PiInstance, options: HookComposerOptions = {}): OctocodeHookComposer {
  return new OctocodeHookComposer(pi, options);
}
