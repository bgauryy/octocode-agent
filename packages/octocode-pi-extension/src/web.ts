import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { callLine, preview, resultText, textComponent } from './render.js';
import { capOutput, errorMessage, isRecord, textResult } from './util.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const point = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Readable text from HTML: drops scripts/styles/chrome, keeps headings, links, list items and paragraphs. */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, '');
  text = text
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inner}\n\n`)
    .replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => `[${inner}](${href})`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|pre|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function fetchUrl(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json,text/plain,*/*' },
    redirect: 'follow',
    signal: combineSignals(signal),
  });
  const type = response.headers.get('content-type') ?? '';
  if (isBinaryType(type)) {
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    // Decoding binary as UTF-8 would flood the context with garbage.
    return `${response.url} is ${type.split(';')[0]}, not text; web cannot read it. Download it with bash (curl -o) if you need the file.`;
  }
  const body = await readCapped(response);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  if (type.includes('html')) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim();
    return `${title ? `# ${decodeEntities(title)}\n` : ''}Source: ${response.url}\n\n${htmlToText(body)}`;
  }
  if (type.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  return body;
}

export function isBinaryType(contentType: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (!type) return false;
  if (type.startsWith('text/') || /[+/](json|xml|javascript|ecmascript|x-www-form-urlencoded|yaml|toml|x-sh)$/.test(type)) return false;
  return /^(image|audio|video|font)\//.test(type) || /^application\/(pdf|zip|gzip|x-tar|x-7z-compressed|octet-stream|wasm|x-bzip2|vnd\.)/.test(type);
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString('utf8');
}

function combineSignals(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function parseDuckDuckGo(html: string, max: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*result__body/).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '';
    hits.push({ url: unwrapDuckDuckGo(decodeEntities(link[1]!)), title: htmlToText(link[2]!), snippet: htmlToText(snippet) });
    if (hits.length >= max) break;
  }
  return hits;
}

function unwrapDuckDuckGo(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') ?? url.toString();
  } catch {
    return href;
  }
}

export async function search(query: string, max: number, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ provider: string; hits: SearchHit[] }> {
  const post = async (url: string, headers: Record<string, string>, body: unknown) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: combineSignals(signal) });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    return (await response.json()) as Record<string, unknown>;
  };
  const list = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);
  if (env['TAVILY_API_KEY']) {
    const data = await post('https://api.tavily.com/search', { authorization: `Bearer ${env['TAVILY_API_KEY']}` }, { query, max_results: max });
    return { provider: 'tavily', hits: list(data['results']).map((r) => ({ title: String(r['title'] ?? ''), url: String(r['url'] ?? ''), snippet: String(r['content'] ?? '') })) };
  }
  if (env['SERPER_API_KEY']) {
    const data = await post('https://google.serper.dev/search', { 'x-api-key': env['SERPER_API_KEY'] }, { q: query, num: max });
    return { provider: 'serper', hits: list(data['organic']).map((r) => ({ title: String(r['title'] ?? ''), url: String(r['link'] ?? ''), snippet: String(r['snippet'] ?? '') })) };
  }
  if (env['EXA_API_KEY']) {
    const data = await post('https://api.exa.ai/search', { 'x-api-key': env['EXA_API_KEY'] }, { query, numResults: max, contents: { text: { maxCharacters: 400 } } });
    return { provider: 'exa', hits: list(data['results']).map((r) => ({ title: String(r['title'] ?? ''), url: String(r['url'] ?? ''), snippet: String(r['text'] ?? '') })) };
  }
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': USER_AGENT }, signal: combineSignals(signal) });
  // DuckDuckGo answers rate limits with a non-200 challenge page; report it instead of "No results".
  if (response.status !== 200) throw new Error(`HTTP ${response.status} from duckduckgo.com (rate limited?). Set TAVILY_API_KEY, SERPER_API_KEY or EXA_API_KEY for reliable search.`);
  return { provider: 'duckduckgo', hits: parseDuckDuckGo(await response.text(), max) };
}

export function registerWebTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'web',
    label: 'Web',
    description:
      'Fetch a URL as readable text (HTML is converted; JSON is pretty-printed), or search the web. Search uses Tavily/Serper/Exa when TAVILY_API_KEY, SERPER_API_KEY or EXA_API_KEY is set, otherwise DuckDuckGo. Use the browser tool instead for pages that need JavaScript or interaction.',
    promptSnippet: 'Fetch a URL as text or search the web',
    promptGuidelines: [
      'When Octocode tools are available, use them for GitHub code, repositories, PRs, issues and commits and for npm packages instead of fetching github.com, raw.githubusercontent.com, api.github.com or npm registry URLs; use web for docs, articles and other sites.',
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: 'URL to fetch' })),
      query: Type.Optional(Type.String({ description: 'Web search query' })),
      maxResults: Type.Optional(Type.Number({ description: 'Search results to return (default 8)' })),
    }),
    renderCall(args, theme, context) {
      const detail = args.url ? theme.fg('mdLink', args.url) : args.query ? `${theme.fg('muted', 'search')} ${theme.fg('accent', `"${args.query}"`)}` : '';
      return textComponent(context, callLine(theme, 'web', detail));
    },
    renderResult(result, { expanded }, theme, context) {
      return textComponent(context, preview(resultText(result), theme, expanded, { color: context.isError ? 'error' : 'toolOutput' }));
    },
    async execute(_id, params, signal) {
      if (params.url) return textResult(capOutput(await fetchUrl(params.url, signal)));
      if (!params.query) throw new Error('Provide url or query.');
      try {
        const { provider, hits } = await search(params.query, Math.min(Math.max(params.maxResults ?? 8, 1), 20), process.env, signal);
        if (hits.length === 0) return textResult(`No results (${provider}).`);
        return textResult(hits.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`).join('\n\n'));
      } catch (error) {
        throw new Error(`Search failed: ${errorMessage(error)}`);
      }
    },
  });
}
