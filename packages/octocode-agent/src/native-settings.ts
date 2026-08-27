import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface StoredSettings { schemaVersion: 1; revision: string; values: Record<string, unknown>; }
const secretKey = /(?:api[_-]?key|secret|token|password|credential)/i;
const digest = (values: Record<string, unknown>): string => createHash('sha256').update(JSON.stringify(values)).digest('hex');

function parse(content: string): StoredSettings {
  const value = JSON.parse(content) as Partial<StoredSettings> & Record<string, unknown>;
  if (value && typeof value === 'object' && !Array.isArray(value) && value.schemaVersion === undefined && value.revision === undefined && value.values === undefined) {
    return { schemaVersion: 1, revision: digest(value), values: value };
  }
  if (value.schemaVersion !== 1 || typeof value.revision !== 'string' || !value.values || typeof value.values !== 'object' || Array.isArray(value.values)) throw new Error('Invalid settings record');
  return value as StoredSettings;
}
function redact(value: unknown, key = ''): unknown {
  if (secretKey.test(key)) return value == null ? null : { configured: true };
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([nested, item]) => [nested, redact(item, nested)]));
  return value;
}

export class FileSettingsStorage {
  constructor(readonly file: string) {}
  read(): StoredSettings {
    if (!fs.existsSync(this.file)) return { schemaVersion: 1, revision: '0', values: {} };
    if (fs.lstatSync(this.file).isSymbolicLink()) throw new Error('Settings path must not be a symbolic link');
    try { return parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      const backup = `${this.file}.bak`;
      if (!fs.existsSync(backup)) throw error;
      const recovered = parse(fs.readFileSync(backup, 'utf8'));
      this.#atomic(this.file, JSON.stringify(recovered, null, 2) + '\n');
      return recovered;
    }
  }
  commit(expectedRevision: string, values: Record<string, unknown>): StoredSettings {
    const current = this.read();
    if (current.revision !== expectedRevision) throw new Error(`Settings revision conflict: expected ${expectedRevision}, current ${current.revision}`);
    const next: StoredSettings = { schemaVersion: 1, revision: digest(values), values };
    if (fs.existsSync(this.file)) this.#atomic(`${this.file}.bak`, JSON.stringify(current, null, 2) + '\n');
    this.#atomic(this.file, JSON.stringify(next, null, 2) + '\n');
    return next;
  }
  project(): { revision: string; values: Record<string, unknown> } {
    const current = this.read();
    return { revision: current.revision, values: redact(current.values) as Record<string, unknown> };
  }
  #atomic(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, content, 'utf8'); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  }
}

const escapeHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const sections = ['overview', 'runtime', 'appearance', 'models', 'hooks', 'plugins', 'commands', 'connections', 'add-server', 'discovery', 'agent-context', 'skills', 'overrides', 'diagnostics'] as const;
export function renderSettingsHtml(snapshot: { revision: string; values: Record<string, unknown> }): string {
  const values = escapeHtml(JSON.stringify(redact(snapshot.values), null, 2));
  const navigation = sections.map((section) => `<a href="#${section}">${escapeHtml(section)}</a>`).join('');
  const content = sections.map((section) => `<section id="${section}"><h2>${escapeHtml(section)}</h2>${section === 'overrides' ? `<pre>${values}</pre>` : '<p>No unreviewed values.</p>'}</section>`).join('');
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width"><title>Octocode settings</title><style>body{font-family:system-ui;display:grid;grid-template-columns:14rem 1fr;gap:2rem;margin:2rem}nav{display:flex;flex-direction:column;gap:.5rem}section{margin-bottom:3rem}pre{white-space:pre-wrap}</style></head><body data-revision="${escapeHtml(snapshot.revision)}"><nav>${navigation}</nav><main>${content}</main></body></html>`;
}
