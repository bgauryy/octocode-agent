/**
 * onboard.ts — interactive first-run flows for octocode-agent (P2).
 *
 * Dependency-free: built on node:readline/promises; secret input is masked by
 * intercepting the Interface's _writeToOutput (the classic no-deps trick).
 * All IO is injectable so the wizard is fully unit-testable without a TTY.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { getOctocodeHome } from './utils.js';
import { AUTH_PROVIDERS, type AuthProvider } from './auth-providers.js';
import {
  checkLines,
  colorEnabled,
  header,
  hint,
  link,
  makePainter,
  section,
  type Painter,
} from './ui.js';

/** Interactive surface the wizard needs; the real one wraps readline. */
export interface WizardIO {
  ask(prompt: string, secret?: boolean): Promise<string | null>;
  out(line: string): void;
}

const KEY_PATTERN = /^[A-Za-z0-9_.\-/+=]{8,}$/;

function defaultIO(): WizardIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(prompt, secret) {
      if (secret) {
        const iface = rl as unknown as Record<string, unknown>;
        const writeToOutput = iface['_writeToOutput'] as (chunk: string) => void;
        iface['_writeToOutput'] = (chunk: string) => {
          // Echo nothing but newlines — mask the pasted key.
          if (chunk === '\r\n') (iface['output'] as NodeJS.WritableStream).write(chunk);
        };
        try {
          const answer = await rl.question(prompt);
          process.stdout.write('\n');
          return answer;
        } finally {
          iface['_writeToOutput'] = writeToOutput;
        }
      }
      return rl.question(prompt);
    },
    out: (line) => console.log(line),
  };
}

/** Atomic-ish .env upsert: dir 0700, file 0600, KEY=value replaced-or-appended. */
export function upsertEnvFile(envPath: string, name: string, value: string): void {
  fs.mkdirSync(path.dirname(envPath), { recursive: true, mode: 0o700 });
  let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
  const keyLine = `${name}=${value}`;
  const idx = lines.findIndex((l) => l.startsWith(`${name}=`) || l.startsWith(`${name} =`));
  if (idx >= 0) lines[idx] = keyLine;
  else lines = [...lines.filter((l) => l.trim() !== ''), keyLine];
  fs.writeFileSync(envPath, lines.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
}

/** One pick+key sequence; returns the chosen provider or null on abort. */
async function pickProvider(io: WizardIO, p: Painter): Promise<AuthProvider | null> {
  const rows = AUTH_PROVIDERS.map(
    (provider, i) =>
      `  ${p.brand(String(i + 1))}  ${p.bold(provider.keyVar.padEnd(20))} ${p.gray(
        `${link(p, provider.url, provider.host, process.stdout.isTTY)} — ${provider.label}`,
      )}`,
  );
  io.out(section(p, 'Pick a provider') + '\n' + rows.join('\n'));
  const choice = (await io.ask(p.gray(`  number [1-${AUTH_PROVIDERS.length}] (empty to cancel): `)))?.trim();
  if (!choice) return null;
  const n = Number(choice);
  if (!Number.isInteger(n) || n < 1 || n > AUTH_PROVIDERS.length) {
    io.out(`${p.red('✗')} invalid choice`);
    return null;
  }
  return AUTH_PROVIDERS[n - 1];
}

export interface AuthWizardOpts {
  env?: NodeJS.ProcessEnv;
  io?: WizardIO;
  octocodeHome?: string;
}

/**
 * Guided credential setup: pick provider → paste key (masked) → write
 * ~/.octocode/.env (0600). Returns 0 on success, 1 on abort/invalid,
 * 3 when a terminal is unavailable (can't securely read a secret).
 */
export async function runAuthWizard(opts: AuthWizardOpts = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const p = makePainter(colorEnabled(env));

  if (!opts.io && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.log(
      [
        '✗ `auth login` needs an interactive terminal (secret input).',
        hint(p, 'in scripts, export the key yourself: export ANTHROPIC_API_KEY=…'),
      ].join('\n'),
    );
    return 3;
  }
  const io = opts.io ?? defaultIO();

  io.out(header(p, 'auth login'));
  const provider = await pickProvider(io, p);
  if (!provider) {
    io.out(hint(p, 'cancelled — no changes made'));
    return 1;
  }

  const key = (await io.ask(`  paste ${provider.keyVar}: `, true))?.trim() ?? '';
  if (!KEY_PATTERN.test(key)) {
    io.out(`${p.red('✗')} that does not look like an API key (8+ chars, no spaces)`);
    return 1;
  }

  const home = opts.octocodeHome ?? getOctocodeHome(env);
  const envPath = path.join(home, '.env');
  upsertEnvFile(envPath, provider.keyVar, key);
  io.out(
    [
      '',
      ...checkLines(p, 'ok', provider.keyVar, `saved → ${envPath} (0600)`),
      p.dim('Loads automatically at session start. Verify with:'),
      hint(p, 'octocode-agent auth status · octocode-agent doctor'),
    ].join('\n'),
  );
  return 0;
}
