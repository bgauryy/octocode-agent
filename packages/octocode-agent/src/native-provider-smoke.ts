import type { ModelPort } from '@octocodeai/agent-core';
import { createNativeProviderModelPort, type NativeProviderModelOptions, type NativeProviderProtocol } from './native-provider-registry.js';

export type NativeProviderSmokeResult =
  | { readonly status: 'SKIP'; readonly capability: 'credentials-absent'; readonly protocol: NativeProviderProtocol }
  | { readonly status: 'PASS'; readonly protocol: NativeProviderProtocol; readonly stop: 'complete' | 'tool' | 'length' }
  | { readonly status: 'FAIL'; readonly protocol: NativeProviderProtocol; readonly category: 'provider-smoke' };

export interface NativeProviderSmokeOptions {
  readonly protocol: NativeProviderProtocol;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly port?: ModelPort;
}

export interface NativeProviderSmokeMatrixResult {
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  readonly results: readonly NativeProviderSmokeResult[];
  readonly credentialDependent: readonly NativeProviderProtocol[];
}

/** Capability-gated real-adapter probe. Callers decide whether credentials may be used; secrets never enter the receipt. */
export async function runNativeProviderSmoke(options: NativeProviderSmokeOptions): Promise<NativeProviderSmokeResult> {
  if (!options.apiKey) return { status: 'SKIP', capability: 'credentials-absent', protocol: options.protocol };
  const providerOptions = {
    protocol: options.protocol,
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    defaultModel: options.model,
  } as NativeProviderModelOptions;
  const port = options.port ?? createNativeProviderModelPort(providerOptions);
  try {
    const result = await port.run({ messages: [{ role: 'user', content: 'Reply with OK.' }] }, { signal: new AbortController().signal });
    if (result.stop === 'complete' || result.stop === 'tool' || result.stop === 'length') return { status: 'PASS', protocol: options.protocol, stop: result.stop };
    return { status: 'FAIL', protocol: options.protocol, category: 'provider-smoke' };
  } catch {
    return { status: 'FAIL', protocol: options.protocol, category: 'provider-smoke' };
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
