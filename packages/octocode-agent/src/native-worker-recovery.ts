import { createHash } from 'node:crypto';
import path from 'node:path';
import { agentDbPath, appendWorkerLifecycleEvent, closeOctocodeDb, listWorkerLifecycleEvents, openOctocodeDb, type StoredWorkerLifecycleEvent } from '@octocodeai/octocode-awareness/mcp-state';
import { probeNativeWorkerProcessIdentity, sameNativeWorkerProcess, type NativeWorkerProcessIdentity } from './native-workers.js';

const REPLAY_PAGE_SIZE = 1_000;
const ORPHAN_REASON = 'Worker process was orphaned by parent restart';

export interface NativeWorkerRecoveryProcess {
  exists(pid: number): boolean;
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  probe(identity: NativeWorkerProcessIdentity): NativeWorkerProcessIdentity | undefined;
}

export interface NativeWorkerRecoveryOptions {
  readonly workspace: string;
  readonly sessionId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly process?: NativeWorkerRecoveryProcess;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly pollMs?: number;
}

export interface NativeWorkerOrphanReceipt {
  readonly workerId: string;
  readonly correlationId: string;
  readonly sessionId: string;
  readonly state: 'orphaned';
  readonly outcome: 'failed';
  readonly reason: typeof ORPHAN_REASON;
  readonly lastSequence: number;
  readonly termination: 'already-exited' | 'identity-replaced' | 'terminated' | 'killed';
}

function recoveryPacketId(event: StoredWorkerLifecycleEvent): string {
  return `recovery_${createHash('sha256').update(`${event.workspace}\0${event.sessionId}\0${event.workerId}\0${event.correlationId}`).digest('hex')}`;
}

function replayAll(db: ReturnType<typeof openOctocodeDb>, workspace: string, sessionId: string): StoredWorkerLifecycleEvent[] {
  const events: StoredWorkerLifecycleEvent[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = listWorkerLifecycleEvents(db, { workspace, sessionId, afterSequence, limit: REPLAY_PAGE_SIZE });
    events.push(...page);
    if (page.length < REPLAY_PAGE_SIZE) return events;
    afterSequence = page.at(-1)!.sequence;
  }
}

function processIdentity(event: StoredWorkerLifecycleEvent): NativeWorkerProcessIdentity | undefined {
  if (event.type !== 'worker.process' || typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) return undefined;
  const value = event.payload as Record<string, unknown>;
  if (!Number.isSafeInteger(value['pid']) || (value['pid'] as number) < 1
    || typeof value['startToken'] !== 'string' || !value['startToken']
    || typeof value['commandSha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['commandSha256'])
    || typeof value['ownershipTokenSha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['ownershipTokenSha256'])
    || (value['verification'] !== 'linux-proc' && value['verification'] !== 'darwin-ps')) return undefined;
  return { pid: value['pid'] as number, startToken: value['startToken'], commandSha256: value['commandSha256'], ownershipTokenSha256: value['ownershipTokenSha256'], verification: value['verification'] };
}

function defaultProcess(): NativeWorkerRecoveryProcess {
  return {
    exists(pid) {
      try { process.kill(pid, 0); return true; }
      catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
    },
    signal(pid, signal) { process.kill(pid, signal); },
    probe: probeNativeWorkerProcessIdentity,
  };
}

function duration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > 60_000) throw new Error(`${label} must be an integer from 0 to 60000`);
  return result;
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForOwnedExit(identity: NativeWorkerProcessIdentity, processPort: NativeWorkerRecoveryProcess, timeoutMs: number, pollMs: number): Promise<'gone' | 'replaced' | 'same' | 'unverifiable'> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!processPort.exists(identity.pid)) return 'gone';
    const current = processPort.probe(identity);
    if (current === undefined) return 'unverifiable';
    if (!sameNativeWorkerProcess(identity, current)) return 'replaced';
    if (Date.now() >= deadline) return 'same';
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

async function terminateOwnedProcess(identity: NativeWorkerProcessIdentity, processPort: NativeWorkerRecoveryProcess, termGraceMs: number, killGraceMs: number, pollMs: number): Promise<NativeWorkerOrphanReceipt['termination'] | undefined> {
  if (!processPort.exists(identity.pid)) return 'already-exited';
  const current = processPort.probe(identity);
  if (current === undefined) return undefined;
  if (!sameNativeWorkerProcess(identity, current)) return 'identity-replaced';
  try { processPort.signal(identity.pid, 'SIGTERM'); }
  catch { return processPort.exists(identity.pid) ? undefined : 'terminated'; }
  const afterTerm = await waitForOwnedExit(identity, processPort, termGraceMs, pollMs);
  if (afterTerm === 'gone') return 'terminated';
  if (afterTerm === 'replaced') return 'terminated';
  if (afterTerm === 'unverifiable') return undefined;
  const beforeKill = processPort.probe(identity);
  if (beforeKill === undefined || !sameNativeWorkerProcess(identity, beforeKill)) return beforeKill === undefined ? undefined : 'identity-replaced';
  try { processPort.signal(identity.pid, 'SIGKILL'); }
  catch { return processPort.exists(identity.pid) ? undefined : 'killed'; }
  const afterKill = await waitForOwnedExit(identity, processPort, killGraceMs, pollMs);
  if (afterKill === 'gone') return 'killed';
  if (afterKill === 'replaced') return 'killed';
  return undefined;
}

/** Reconciles durable nonterminal workers and signals only a revalidated owned process identity. */
export async function recoverNativeWorkerOrphans(options: NativeWorkerRecoveryOptions): Promise<readonly NativeWorkerOrphanReceipt[]> {
  const workspace = path.resolve(options.workspace);
  const dbPath = agentDbPath(options.env);
  const db = openOctocodeDb(dbPath);
  const termGraceMs = duration(options.termGraceMs, 1_000, 'termGraceMs');
  const killGraceMs = duration(options.killGraceMs, 1_000, 'killGraceMs');
  const pollMs = Math.max(1, duration(options.pollMs, 25, 'pollMs'));
  const processPort = options.process ?? defaultProcess();
  try {
    const records = new Map<string, { latest: StoredWorkerLifecycleEvent; identity?: NativeWorkerProcessIdentity }>();
    for (const event of replayAll(db, workspace, options.sessionId)) {
      const current = records.get(event.workerId);
      const identity = processIdentity(event) ?? current?.identity;
      records.set(event.workerId, { latest: event, ...(identity === undefined ? {} : { identity }) });
    }
    const receipts: NativeWorkerOrphanReceipt[] = [];
    for (const record of [...records.values()].sort((left, right) => left.latest.sequence - right.latest.sequence)) {
      const event = record.latest;
      if (event.type === 'worker.terminal' || record.identity === undefined) continue;
      const termination = await terminateOwnedProcess(record.identity, processPort, termGraceMs, killGraceMs, pollMs);
      if (termination === undefined) continue;
      appendWorkerLifecycleEvent(db, {
        packetId: recoveryPacketId(event), workspace, sessionId: event.sessionId, workerId: event.workerId, correlationId: event.correlationId,
        type: 'worker.terminal', redaction: event.redaction, createdAt: new Date((options.now ?? Date.now)()).toISOString(),
        payload: { outcome: 'failed', reason: ORPHAN_REASON, recovery: 'restart-orphan', termination },
      });
      receipts.push({ workerId: event.workerId, correlationId: event.correlationId, sessionId: event.sessionId, state: 'orphaned', outcome: 'failed', reason: ORPHAN_REASON, lastSequence: event.sequence, termination });
    }
    return Object.freeze(receipts.map((receipt) => Object.freeze(receipt)));
  } finally { closeOctocodeDb(dbPath); }
}
