import { launch, type LaunchedChrome } from 'chrome-launcher';
import { withTimeout } from './util.js';

/**
 * Minimal Chrome DevTools Protocol session over the page websocket. Attaches to
 * a Chrome already listening on OCTOCODE_CHROME_PORT (default 9222) so the
 * user's logged-in profile can be reused; otherwise launches its own Chrome.
 */
export class CdpPage {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      // A throwing EventTarget listener surfaces as an uncaught exception in Pi's process.
      let message: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.#listeners) {
          try {
            listener(message.method, message.params ?? {});
          } catch {
            // One bad event must not break the session.
          }
        }
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.#pending.values()) pending.reject(new Error('Browser connection closed'));
      this.#pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpPage> {
    const socket = new WebSocket(url);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
      }),
      10_000,
      'Browser connect',
    );
    return new CdpPage(socket);
  }

  get open(): boolean {
    return this.#socket.readyState === WebSocket.OPEN;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.#nextId++;
    if (!this.open) return Promise.reject(new Error('Browser connection closed'));
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    return withTimeout(result, 30_000, method).finally(() => this.#pending.delete(id));
  }

  on(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  waitFor(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const off = this.on((name) => name === method && done());
      function done() {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const response = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Evaluation failed');
    return response.result?.value as T;
  }

  close(): void {
    this.#socket.close();
  }
}

export interface BrowserSession {
  page: CdpPage;
  chrome?: LaunchedChrome;
  /** Closes the tab this session opened in a Chrome it attached to. */
  closeTab?: () => Promise<void>;
  console: string[];
}

interface PageTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

export async function openBrowser(env: NodeJS.ProcessEnv = process.env): Promise<BrowserSession> {
  const port = Number(env['OCTOCODE_CHROME_PORT'] ?? 9222);
  let chrome: LaunchedChrome | undefined;
  let closeTab: (() => Promise<void>) | undefined;
  // Attaching to the user's Chrome: work in a tab of our own instead of taking over one they have open.
  let target = await newTab(port).catch(() => undefined);
  if (target) {
    const id = target.id;
    closeTab = async () => {
      await fetch(`http://127.0.0.1:${port}/json/close/${id}`, { signal: AbortSignal.timeout(2_000) });
    };
  } else {
    const headless = env['OCTOCODE_BROWSER_HEADLESS'] !== '0';
    chrome = await launch({ startingUrl: 'about:blank', chromeFlags: [...(headless ? ['--headless=new'] : []), '--no-first-run', '--no-default-browser-check'] });
    try {
      target = await firstPage(chrome.port);
    } catch (error) {
      await chrome.kill();
      throw error;
    }
  }
  const page = await CdpPage.connect(target.webSocketDebuggerUrl);
  const session: BrowserSession = { page, console: [], ...(chrome ? { chrome } : {}), ...(closeTab ? { closeTab } : {}) };
  page.on((method, params) => {
    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params['args']) ? params['args'] : [];
      const text = args.map((arg) => String((arg as { value?: unknown; description?: string }).value ?? (arg as { description?: string }).description ?? '')).join(' ');
      session.console = [...session.console.slice(-199), `[${String(params['type'])}] ${text}`];
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined;
      session.console = [...session.console.slice(-199), `[exception] ${details?.exception?.description ?? details?.text ?? ''}`];
    }
  });
  await Promise.all([page.send('Page.enable'), page.send('Runtime.enable')]);
  return session;
}

async function newTab(port: number): Promise<PageTarget> {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`Chrome on port ${port} refused a new tab (HTTP ${response.status})`);
  return (await response.json()) as PageTarget;
}

/** The about:blank page of a Chrome this session launched. */
async function firstPage(port: number): Promise<PageTarget> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })).json()) as Array<Partial<PageTarget> & { type: string }>;
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl && target.id);
  return page ? (page as PageTarget) : newTab(port);
}
