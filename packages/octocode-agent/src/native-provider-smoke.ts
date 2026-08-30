import type { ModelPort } from '@octocodeai/agent-core';
import { createNativeProviderModelPort, type NativeProviderModelOptions, type NativeProviderProtocol } from './native-provider-registry.js';

export type NativeProviderSmokeResult =
  | { readonly status: 'SKIP'; readonly capability: 'credentials-absent'; readonly protocol: NativeProviderProtocol }
  | { readonly status: 'PASS'; readonly protocol: NativeProviderProtocol; readonly stop: 'complete' | 'tool' | 'length' }
  | { readonly status: 'FAIL'; readonly protocol: NativeProviderProtocol; readonly category: 'provider-smoke'; readonly reason: 'unauthorized' | 'not-found' | 'rate-limited' | 'timeout' | 'provider-error' };

export interface NativeProviderSmokeOptions {
  readonly protocol: NativeProviderProtocol;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly resolveAuth?: NativeProviderModelOptions['resolveAuth'];
  readonly promptCaching?: boolean;
  readonly sessionAffinityId?: string;
  readonly maxOutputTokens?: number;
  readonly port?: ModelPort;
  readonly timeoutMs?: number;
}

export interface NativeProviderSmokeMatrixResult {
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  readonly results: readonly NativeProviderSmokeResult[];
  readonly credentialDependent: readonly NativeProviderProtocol[];
}

/** Capability-gated real-adapter probe. Callers decide whether credentials may be used; secrets never enter the receipt. */
export async function runNativeProviderSmoke(options: NativeProviderSmokeOptions): Promise<NativeProviderSmokeResult> {
  if (!options.apiKey && options.resolveAuth === undefined) return { status: 'SKIP', capability: 'credentials-absent', protocol: options.protocol };
  const providerOptions = {
    protocol: options.protocol,
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    ...(options.resolveAuth === undefined ? {} : { resolveAuth: options.resolveAuth }),
    defaultModel: options.model,
    ...(options.protocol === 'anthropic-messages' && options.promptCaching !== undefined ? { promptCaching: options.promptCaching } : {}),
    ...(options.protocol === 'anthropic-messages' && options.sessionAffinityId !== undefined ? { sessionAffinityId: options.sessionAffinityId } : {}),
    ...(options.protocol === 'anthropic-messages' && options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
  } as NativeProviderModelOptions;
  const port = options.port ?? createNativeProviderModelPort(providerOptions);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timeout = setTimeout(() => controller.abort(new Error('provider health probe timed out')), timeoutMs);
  timeout.unref();
  try {
    const result = await port.run({
      messages: [
        { role: 'system', content: 'You are an Octocode provider health check. Follow the user instruction exactly.' },
        { role: 'user', content: 'Reply with OK.' },
      ],
    }, { signal: controller.signal });
    if (result.stop === 'complete' || result.stop === 'tool' || result.stop === 'length') return { status: 'PASS', protocol: options.protocol, stop: result.stop };
    return { status: 'FAIL', protocol: options.protocol, category: 'provider-smoke', reason: 'provider-error' };
  } catch (error) {
    const status = typeof error === 'object' && error !== null
      ? ('status' in error && typeof error.status === 'number' ? error.status
        : 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode
          : 'safeCause' in error && typeof error.safeCause === 'string' && /^http:\d+$/.test(error.safeCause)
            ? Number(error.safeCause.slice('http:'.length)) : undefined)
      : undefined;
    const reason = controller.signal.aborted ? 'timeout' : status === 401 ? 'unauthorized' : status === 404 ? 'not-found' : status === 429 ? 'rate-limited' : 'provider-error';
    return { status: 'FAIL', protocol: options.protocol, category: 'provider-smoke', reason };
  } finally {
    clearTimeout(timeout);
  }
}

/** Runs a bounded protocol matrix and keeps credential-dependent gates explicit. */
export async function runNativeProviderSmokeMatrix(
  targets: readonly NativeProviderSmokeOptions[],
): Promise<NativeProviderSmokeMatrixResult> {
  const results = await Promise.all(targets.map(runNativeProviderSmoke));
  const credentialDependent = results.flatMap((result) => result.status === 'SKIP' ? [result.protocol] : []);
  const status = results.some((result) => result.status === 'FAIL')
    ? 'FAIL'
    : results.every((result) => result.status === 'SKIP') ? 'SKIP' : 'PASS';
  return { status, results, credentialDependent };
}
