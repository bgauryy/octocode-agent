import { connectNativeMcp, type NativeMcpClient, type NativeMcpOptions, type NativeMcpServerConfig } from './native-mcp.js';

export type NativeMcpSmokeAuth = 'none' | 'static' | 'oauth';

export interface NativeMcpSmokeOptions {
  readonly name: string;
  readonly auth: NativeMcpSmokeAuth;
  readonly credentialConfigured: boolean;
  readonly config: NativeMcpServerConfig;
  readonly options: NativeMcpOptions;
  readonly connect?: (name: string, config: NativeMcpServerConfig, signal: AbortSignal, options: NativeMcpOptions) => Promise<NativeMcpClient>;
  readonly timeoutMs?: number;
}

export type NativeMcpSmokeResult =
  | { readonly status: 'SKIP'; readonly name: string; readonly transport: NativeMcpServerConfig['transport']; readonly auth: NativeMcpSmokeAuth; readonly capability: 'credentials-absent' }
  | { readonly status: 'PASS'; readonly name: string; readonly transport: NativeMcpServerConfig['transport']; readonly auth: NativeMcpSmokeAuth; readonly toolCount: number }
  | { readonly status: 'FAIL'; readonly name: string; readonly transport: NativeMcpServerConfig['transport']; readonly auth: NativeMcpSmokeAuth; readonly reason: 'connection-failed' | 'catalog-invalid' | 'timeout' };

export interface NativeMcpSmokeMatrixResult {
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  readonly results: readonly NativeMcpSmokeResult[];
  readonly credentialDependent: readonly string[];
}

export async function runNativeMcpSmoke(target: NativeMcpSmokeOptions): Promise<NativeMcpSmokeResult> {
  const receipt = { name: target.name, transport: target.config.transport, auth: target.auth } as const;
  if (target.auth !== 'none' && !target.credentialConfigured) {
    return { status: 'SKIP', ...receipt, capability: 'credentials-absent' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('MCP smoke timed out')), target.timeoutMs ?? 15_000);
  timeout.unref();
  let client: NativeMcpClient | undefined;
  try {
    client = await (target.connect ?? connectNativeMcp)(target.name, target.config, controller.signal, target.options);
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const catalog = await client.listTools(cursor ? { cursor } : {}, { signal: controller.signal, timeout: target.timeoutMs ?? 15_000 });
      if (!Array.isArray(catalog.tools)) return { status: 'FAIL', ...receipt, reason: 'catalog-invalid' };
      for (const tool of catalog.tools) {
        if (typeof tool.name !== 'string' || !tool.name || names.has(tool.name) || names.size >= 1_000) {
          return { status: 'FAIL', ...receipt, reason: 'catalog-invalid' };
        }
        names.add(tool.name);
      }
      cursor = catalog.nextCursor;
      if (!cursor) return { status: 'PASS', ...receipt, toolCount: names.size };
      if (cursor.length > 8_192) return { status: 'FAIL', ...receipt, reason: 'catalog-invalid' };
    }
    return { status: 'FAIL', ...receipt, reason: 'catalog-invalid' };
  } catch {
    return { status: 'FAIL', ...receipt, reason: controller.signal.aborted ? 'timeout' : 'connection-failed' };
  } finally {
    clearTimeout(timeout);
    await client?.close().catch(() => undefined);
  }
}

export async function runNativeMcpSmokeMatrix(targets: readonly NativeMcpSmokeOptions[]): Promise<NativeMcpSmokeMatrixResult> {
  const results = await Promise.all(targets.map(runNativeMcpSmoke));
  const credentialDependent = results.flatMap((result) => result.status === 'SKIP' ? [result.name] : []);
  const status = results.some((result) => result.status === 'FAIL')
    ? 'FAIL'
    : results.every((result) => result.status === 'SKIP') ? 'SKIP' : 'PASS';
  return { status, results, credentialDependent };
}
