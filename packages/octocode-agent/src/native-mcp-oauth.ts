import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';

import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

const MAX_STORED_CREDENTIAL_BYTES = 64 * 1024;
const CALLBACK_PATH = '/oauth/callback';

export interface NativeCredentialStorePort {
  read(account: string): Promise<string | undefined>;
  write(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface NativeCredentialCommandRunner {
  run(command: string, args: readonly string[], stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export async function openNativeApprovedOAuthUrl(
  target: string,
  options: {
    platform?: NodeJS.Platform;
    launch?: (command: string, args: readonly string[]) => Promise<boolean>;
  } = {},
): Promise<{ ok: boolean }> {
  let url: URL;
  try { url = new URL(target); } catch { return { ok: false }; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(url.hostname))) {
    return { ok: false };
  }
  const platform = options.platform ?? process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32' : platform === 'linux' ? 'xdg-open' : undefined;
  if (!command) return { ok: false };
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
  const launch = options.launch ?? ((executable, argv) => new Promise<boolean>((resolve) => {
    const child = spawn(executable, [...argv], { shell: false, stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => { child.unref(); resolve(true); });
  }));
  return { ok: await launch(command, args) };
}

function defaultCredentialCommandRunner(): NativeCredentialCommandRunner {
  return {
    run(command, args, stdin) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { if (stdout.length < MAX_STORED_CREDENTIAL_BYTES) stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { if (stderr.length < 4096) stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
        child.stdin.end(stdin);
      });
    },
  };
}

/** Uses the host credential manager; no OAuth material is written to repository or config files. */
export function createNativeOsCredentialStore(options: {
  platform?: NodeJS.Platform;
  runner?: NativeCredentialCommandRunner;
  service?: string;
} = {}): NativeCredentialStorePort {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultCredentialCommandRunner();
  const service = options.service ?? 'octocode-agent';
  const execute = async (command: string, args: readonly string[], stdin?: string, allowMissing = false): Promise<string | undefined> => {
    const result = await runner.run(command, args, stdin);
    if (result.exitCode === 0) return result.stdout.trimEnd();
    if (allowMissing) return undefined;
    throw new Error('Operating-system credential storage failed');
  };
  if (platform === 'darwin') return {
    read: (account) => execute('security', ['find-generic-password', '-s', service, '-a', account, '-w'], undefined, true),
    async write(account, value) {
      await execute('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
    },
    async delete(account) {
      await execute('security', ['delete-generic-password', '-s', service, '-a', account], undefined, true);
    },
  };
  if (platform === 'linux') return {
    read: (account) => execute('secret-tool', ['lookup', 'service', service, 'account', account], undefined, true),
    async write(account, value) {
      await execute('secret-tool', ['store', '--label', 'Octocode Agent MCP OAuth', 'service', service, 'account', account], value);
    },
    async delete(account) {
      await execute('secret-tool', ['clear', 'service', service, 'account', account], undefined, true);
    },
  };
  return {
    async read() { throw new Error(`Secure MCP OAuth credential storage is unavailable on ${platform}`); },
    async write() { throw new Error(`Secure MCP OAuth credential storage is unavailable on ${platform}`); },
    async delete() { throw new Error(`Secure MCP OAuth credential storage is unavailable on ${platform}`); },
  };
}

export interface NativeMcpOAuthStoredCredential {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export interface NativeMcpOAuthTransport {
  finishAuth(params: URLSearchParams): Promise<void>;
}

export interface NativeMcpOAuthFlow {
  readonly provider: OAuthClientProvider;
  readonly redirectUrl: string;
  attachTransport(transport: NativeMcpOAuthTransport): void;
  status(): Promise<{ state: 'authorization-required' | 'connected'; credentialConfigured: boolean }>;
  revoke(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateNativeMcpOAuthFlowOptions {
  serverName: string;
  serverUrl: string;
  credentialStore: NativeCredentialStorePort;
  approve(input: { serverName: string; serverOrigin: string; authorizationOrigin: string }): Promise<boolean>;
  openApprovedUrl(url: string): Promise<{ ok: boolean }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTokens(value: unknown): value is StoredOAuthTokens {
  return isRecord(value)
    && typeof value.access_token === 'string'
    && value.access_token.length > 0
    && typeof value.token_type === 'string'
    && value.token_type.length > 0;
}

function validCredential(value: unknown): value is NativeMcpOAuthStoredCredential {
  if (!isRecord(value)) return false;
  if (value.tokens !== undefined && !validTokens(value.tokens)) return false;
  if (value.codeVerifier !== undefined
    && (typeof value.codeVerifier !== 'string' || value.codeVerifier.length < 1 || value.codeVerifier.length > 1024)) return false;
  if (value.clientInformation !== undefined && !isRecord(value.clientInformation)) return false;
  if (value.discoveryState !== undefined && !isRecord(value.discoveryState)) return false;
  return true;
}

async function loadCredential(store: NativeCredentialStorePort, account: string): Promise<NativeMcpOAuthStoredCredential> {
  const stored = await store.read(account);
  if (stored === undefined || Buffer.byteLength(stored, 'utf8') > MAX_STORED_CREDENTIAL_BYTES) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    return validCredential(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function canonicalOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('MCP OAuth server URL must use HTTP or HTTPS');
  return url.origin;
}

export function nativeMcpOAuthAccount(serverName: string, serverUrl: string): string {
  const digest = createHash('sha256').update(`${serverName}\0${canonicalOrigin(serverUrl)}`).digest('hex');
  return `mcp-oauth:${serverName}:${digest}`;
}

export async function nativeMcpOAuthCredentialStatus(options: {
  serverName: string;
  serverUrl: string;
  credentialStore: NativeCredentialStorePort;
}): Promise<{ state: 'authorization-required' | 'connected'; credentialConfigured: boolean }> {
  const credential = await loadCredential(options.credentialStore, nativeMcpOAuthAccount(options.serverName, options.serverUrl));
  const credentialConfigured = validTokens(credential.tokens);
  return { state: credentialConfigured ? 'connected' : 'authorization-required', credentialConfigured };
}

export async function revokeNativeMcpOAuthCredential(options: {
  serverName: string;
  serverUrl: string;
  credentialStore: NativeCredentialStorePort;
}): Promise<void> {
  await options.credentialStore.delete(nativeMcpOAuthAccount(options.serverName, options.serverUrl));
}

async function listenLoopback(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('OAuth callback did not bind a TCP port'));
      resolve(address.port);
    });
  });
}

export async function createNativeMcpOAuthFlow(options: CreateNativeMcpOAuthFlowOptions): Promise<NativeMcpOAuthFlow> {
  const serverOrigin = canonicalOrigin(options.serverUrl);
  const account = nativeMcpOAuthAccount(options.serverName, options.serverUrl);
  let credential = await loadCredential(options.credentialStore, account);

  let transport: NativeMcpOAuthTransport | undefined;
  let expectedState: string | undefined;
  let callbackResolve: (() => void) | undefined;
  let callbackReject: ((error: Error) => void) | undefined;
  let closed = false;

  const persist = async (): Promise<void> => {
    const encoded = JSON.stringify(credential);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_STORED_CREDENTIAL_BYTES) throw new Error('MCP OAuth credential record exceeds the storage limit');
    await options.credentialStore.write(account, encoded);
  };

  const callbackServer = http.createServer((request, response) => {
    void (async () => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      if (request.method !== 'GET' || !request.url || request.headers.host !== `127.0.0.1:${port}`) {
        response.writeHead(404).end('Not found');
        return;
      }
      const callback = new URL(request.url, redirectUrl);
      if (callback.pathname !== CALLBACK_PATH
        || !expectedState
        || callback.searchParams.get('state') !== expectedState
        || !callback.searchParams.get('code')) {
        response.writeHead(400).end('Authorization callback rejected');
        return;
      }
      if (!transport) {
        response.writeHead(409).end('OAuth transport is not ready');
        return;
      }
      try {
        await transport.finishAuth(callback.searchParams);
        response.writeHead(200).end('Authorization completed. You can return to Octocode.');
        callbackResolve?.();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        response.writeHead(502).end('Authorization could not be completed');
        callbackReject?.(failure);
      }
    })().catch((error: unknown) => {
      response.writeHead(500).end('Authorization callback failed');
      callbackReject?.(error instanceof Error ? error : new Error(String(error)));
    });
  });
  const port = await listenLoopback(callbackServer);
  const redirectUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  const clientMetadata: OAuthClientMetadata = {
    client_name: 'Octocode Agent',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };

  const provider: OAuthClientProvider = {
    redirectUrl,
    clientMetadata,
    state: () => randomBytes(24).toString('base64url'),
    clientInformation: (_context?: OAuthClientInformationContext) => credential.clientInformation,
    saveClientInformation: async (value: StoredOAuthClientInformation) => {
      credential.clientInformation = value;
      await persist();
    },
    tokens: (_context?: OAuthClientInformationContext) => credential.tokens,
    saveTokens: async (value: StoredOAuthTokens) => {
      if (!validTokens(value)) throw new Error('MCP OAuth returned malformed tokens');
      credential.tokens = value;
      await persist();
    },
    saveCodeVerifier: async (value: string) => {
      if (value.length < 1 || value.length > 1024) throw new Error('MCP OAuth code verifier is invalid');
      credential.codeVerifier = value;
      await persist();
    },
    codeVerifier: () => {
      if (!credential.codeVerifier) throw new Error('MCP OAuth code verifier is unavailable');
      return credential.codeVerifier;
    },
    redirectToAuthorization: async (authorizationUrl: URL) => {
      expectedState = authorizationUrl.searchParams.get('state') ?? undefined;
      if (!expectedState) throw new Error('MCP OAuth authorization URL is missing state');
      const approved = await options.approve({
        serverName: options.serverName,
        serverOrigin,
        authorizationOrigin: authorizationUrl.origin,
      });
      if (!approved) throw new Error('MCP OAuth authorization denied');
      const opened = await options.openApprovedUrl(authorizationUrl.href);
      if (!opened.ok) throw new Error('MCP OAuth authorization URL could not be opened');
      await new Promise<void>((resolve, reject) => {
        callbackResolve = resolve;
        callbackReject = reject;
      });
    },
    invalidateCredentials: async (scope) => {
      if (scope === 'all') credential = {};
      if (scope === 'client') delete credential.clientInformation;
      if (scope === 'tokens') delete credential.tokens;
      if (scope === 'verifier') delete credential.codeVerifier;
      if (scope === 'discovery') delete credential.discoveryState;
      await persist();
    },
    saveDiscoveryState: async (state: OAuthDiscoveryState) => {
      credential.discoveryState = state;
      await persist();
    },
    discoveryState: () => credential.discoveryState,
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    callbackReject?.(new Error('MCP OAuth flow closed'));
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  };

  return {
    provider,
    redirectUrl,
    attachTransport(value) { transport = value; },
    async status() {
      const credentialConfigured = validTokens(credential.tokens);
      return { state: credentialConfigured ? 'connected' : 'authorization-required', credentialConfigured };
    },
    async revoke() {
      credential = {};
      await options.credentialStore.delete(account);
    },
    close,
  };
}
