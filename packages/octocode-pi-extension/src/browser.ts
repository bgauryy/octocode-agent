import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { openBrowser, type BrowserSession } from './browser-cdp.js';
import { callLine, preview, resultText, textComponent } from './render.js';
import { capOutput, textResult } from './util.js';

const ACTIONS = ['navigate', 'snapshot', 'click', 'type', 'press', 'evaluate', 'screenshot', 'console', 'close'] as const;

/** Numbers visible interactive elements (data-octo-ref) and returns page text plus the element list. */
const SNAPSHOT_SCRIPT = `(() => {
  const selector = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=true],[onclick]';
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  const items = [];
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el)) continue;
    n += 1;
    el.setAttribute('data-octo-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const href = tag === 'a' ? ' -> ' + el.getAttribute('href') : '';
    items.push('[' + n + '] ' + tag + (type ? ':' + type : '') + ' "' + label(el) + '"' + href);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 20000);
  return { title: document.title, url: location.href, text, items };
})()`;

const elementExpr = (ref: number) => `document.querySelector('[data-octo-ref="${ref}"]')`;

export class BrowserTool {
  #session: BrowserSession | undefined;

  async session(): Promise<BrowserSession> {
    if (this.#session?.page.open) return this.#session;
    // The page connection dropped: release what the old session owns before opening a new one.
    await this.close();
    this.#session = await openBrowser();
    return this.#session;
  }

  async close(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (!session) return;
    await session.closeTab?.().catch(() => undefined);
    session.page.close();
    await session.chrome?.kill();
  }
}

export function registerBrowserTool(pi: ExtensionAPI, browser: BrowserTool): void {
  pi.registerTool({
    name: 'browser',
    label: 'Browser',
    description:
      'Control a real Chrome browser (reuses Chrome on port OCTOCODE_CHROME_PORT/9222 when running, else launches headless; OCTOCODE_BROWSER_HEADLESS=0 shows it). ' +
      'Actions: navigate(url); snapshot → page text + numbered interactive elements; click(ref); type(ref, text, submit?); press(key); evaluate(expression); screenshot; console (logs and errors); close. ' +
      'Element refs come from the latest snapshot — snapshot again after the page changes.',
    promptSnippet: 'Drive Chrome: navigate, snapshot, click, type, evaluate, screenshot, console logs',
    // One shared page: parallel actions would race (a click against a navigation, stale element refs).
    executionMode: 'sequential',
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      url: Type.Optional(Type.String({ description: 'URL for navigate' })),
      ref: Type.Optional(Type.Number({ description: 'Element number from snapshot' })),
      text: Type.Optional(Type.String({ description: 'Text for type (replaces the field value)' })),
      submit: Type.Optional(Type.Boolean({ description: 'Press Enter after typing' })),
      key: Type.Optional(Type.String({ description: 'Key for press, e.g. Enter, Tab, Escape' })),
      expression: Type.Optional(Type.String({ description: 'JavaScript expression for evaluate' })),
    }),
    renderCall(args, theme, context) {
      const target = args.url ?? (args.ref !== undefined ? `[${args.ref}]` : undefined) ?? args.key ?? (args.expression ? args.expression.split('\n')[0]!.slice(0, 80) : undefined);
      const typed = args.action === 'type' && args.text ? ` ${theme.fg('muted', JSON.stringify(args.text.slice(0, 60)))}` : '';
      return textComponent(context, callLine(theme, 'browser', `${theme.fg('accent', args.action ?? '')}${target ? ` ${theme.fg('mdLink', target)}` : ''}${typed}`));
    },
    renderResult(result, { expanded }, theme, context) {
      // Screenshots are drawn by Pi from the image content; snapshots collapse to the title and URL.
      return textComponent(context, preview(resultText(result).replace(/^\[image\]$/m, ''), theme, expanded, { max: 3, color: context.isError ? 'error' : 'toolOutput' }));
    },
    async execute(_id, params) {
      if (params.action === 'close') {
        await browser.close();
        return textResult('Browser closed.');
      }
      const { page, console: logs } = await browser.session();
      switch (params.action) {
        case 'navigate': {
          if (!params.url) throw new Error('navigate needs url');
          const loaded = page.waitFor('Page.loadEventFired', 20_000);
          const result = await page.send<{ errorText?: string }>('Page.navigate', { url: params.url });
          if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
          await loaded;
          return textResult(await snapshot(page));
        }
        case 'snapshot':
          return textResult(await snapshot(page));
        case 'click': {
          const ref = requireRef(params.ref);
          const ok = await page.evaluate<boolean>(`(() => { const el = ${elementExpr(ref)}; if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
          if (!ok) throw new Error(`No element [${ref}] — take a new snapshot.`);
          await settle(page);
          return textResult(await snapshot(page));
        }
        case 'type': {
          const ref = requireRef(params.ref);
          const ok = await page.evaluate<boolean>(`(() => { const el = ${elementExpr(ref)}; if (!el) return false; el.focus(); if ('value' in el) el.value = ''; return true; })()`);
          if (!ok) throw new Error(`No element [${ref}] — take a new snapshot.`);
          await page.send('Input.insertText', { text: params.text ?? '' });
          if (params.submit) await pressKey(page, 'Enter');
          await settle(page);
          return textResult(await snapshot(page));
        }
        case 'press':
          await pressKey(page, params.key ?? 'Enter');
          await settle(page);
          return textResult(await snapshot(page));
        case 'evaluate': {
          if (!params.expression) throw new Error('evaluate needs expression');
          const value = await page.evaluate(params.expression);
          return textResult(capOutput(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'undefined'));
        }
        case 'screenshot': {
          const shot = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
          return { content: [{ type: 'image' as const, data: shot.data, mimeType: 'image/png' }], details: undefined };
        }
        case 'console':
          return textResult(logs.length > 0 ? capOutput(logs.join('\n')) : '(no console messages)');
      }
    },
  });
  pi.on('session_shutdown', async () => browser.close());
}

function requireRef(ref: number | undefined): number {
  if (ref === undefined) throw new Error('This action needs ref (element number from snapshot).');
  return ref;
}

async function snapshot(page: BrowserSession['page']): Promise<string> {
  const data = await page.evaluate<{ title: string; url: string; text: string; items: string[] } | undefined>(SNAPSHOT_SCRIPT);
  if (!data) throw new Error('Could not read the page; wait for it to load and take a snapshot again.');
  return capOutput(`# ${data.title}\n${data.url}\n\n## Elements\n${data.items.join('\n') || '(none)'}\n\n## Text\n${data.text}`);
}

async function settle(page: BrowserSession['page']): Promise<void> {
  await page.waitFor('Page.loadEventFired', 1_500);
}

async function pressKey(page: BrowserSession['page'], key: string): Promise<void> {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const text = key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...(text ? { text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
}
