import { createHash } from 'node:crypto';
import path from 'node:path';
import { appendWorkerLifecycleEvent, connectDb, listWorkerLifecycleEvents, resolveDbPath, storageScopeForCommand, type StoredWorkerLifecycleEvent } from '@octocodeai/octocode-awareness';
import {
  createNodeNativeProcessContainmentPort,
  type NativeProcessContainmentIdentity,
  type NativeProcessContainmentPort,
} from './native-worker-containment.js';

const REPLAY_PAGE_SIZE = 1_000;
const ORPHAN_REASON = 'Worker process was orphaned by parent restart';

export type NativeWorkerRecoveryContainment = Pick<NativeProcessContainmentPort, 'report' | 'signal' | 'wait'>;

export interface NativeWorkerRecoveryOptions {
  readonly workspace: string;
  readonly sessionId: string;
  readonly now?: () => number;
  readonly containment?: NativeWorkerRecoveryContainment;
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

function replayAll(db: ReturnType<typeof connectDb>, workspace: string, sessionId: string): StoredWorkerLifecycleEvent[] {
  const events: StoredWorkerLifecycleEvent[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = listWorkerLifecycleEvents(db, { workspace, sessionId, afterSequence, limit: REPLAY_PAGE_SIZE });
    events.push(...page);
    if (page.length < REPLAY_PAGE_SIZE) return events;
    afterSequence = page.at(-1)!.sequence;
  }
}

function processIdentity(event: StoredWorkerLifecycleEvent): NativeProcessContainmentIdentity | undefined {
  if (event.type !== 'worker.process' || typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) return undefined;
  const value = event.payload as Record<string, unknown>;
  if (value['schemaVersion'] !== 1 || value['kind'] !== 'posix-process-group'
    || !Number.isSafeInteger(value['pid']) || (value['pid'] as number) < 1
    || !Number.isSafeInteger(value['processGroupId']) || (value['processGroupId'] as number) < 1
    || typeof value['generation'] !== 'string' || !value['generation']
    || typeof value['startToken'] !== 'string' || !value['startToken']
    || typeof value['commandSha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['commandSha256'])
    || typeof value['ownershipTokenSha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['ownershipTokenSha256'])
    || (value['verification'] !== 'linux-proc' && value['verification'] !== 'darwin-ps')) return undefined;
  return {
    schemaVersion: 1,
    kind: 'posix-process-group',
    pid: value['pid'] as number,
    processGroupId: value['processGroupId'] as number,
    generation: value['generation'],
    startToken: value['startToken'],
    commandSha256: value['commandSha256'],
    ownershipTokenSha256: value['ownershipTokenSha256'],
    verification: value['verification'],
  };
}

function duration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > 60_000) throw new Error(`${label} must be an integer from 0 to 60000`);
  return result;
}

async function terminateOwnedProcess(identity: NativeProcessContainmentIdentity, containment: NativeWorkerRecoveryContainment, termGraceMs: number, killGraceMs: number, pollMs: number): Promise<NativeWorkerOrphanReceipt['termination'] | undefined> {
  const beforeTerm = containment.report(identity);
  if (beforeTerm.state === 'exited') return 'already-exited';
  if (beforeTerm.state === 'identity-replaced') return 'identity-replaced';
  try { containment.signal(identity, 'SIGTERM'); }
  catch { return undefined; }
  const afterTerm = await containment.wait(identity, { timeoutMs: termGraceMs, pollMs });
  if (afterTerm.state === 'exited') return 'terminated';
  if (afterTerm.state === 'identity-replaced') return 'identity-replaced';
  const beforeKill = containment.report(identity);
  if (beforeKill.state === 'exited') return 'terminated';
  if (beforeKill.state === 'identity-replaced') return 'identity-replaced';
  try { containment.signal(identity, 'SIGKILL'); }
  catch { return undefined; }
  const afterKill = await containment.wait(identity, { timeoutMs: killGraceMs, pollMs });
  if (afterKill.state === 'exited') return 'killed';
  if (afterKill.state === 'identity-replaced') return 'identity-replaced';
  return undefined;
}

/** Reconciles durable nonterminal workers and signals only a revalidated owned process identity. */
export async function recoverNativeWorkerOrphans(options: NativeWorkerRecoveryOptions): Promise<readonly NativeWorkerOrphanReceipt[]> {
  const workspace = path.resolve(options.workspace);
  const dbPath = resolveDbPath(undefined, { scope: storageScopeForCommand('coordination', workspace), workspace });
  const db = connectDb(dbPath);
  const termGraceMs = duration(options.termGraceMs, 1_000, 'termGraceMs');
  const killGraceMs = duration(options.killGraceMs, 1_000, 'killGraceMs');
  const pollMs = Math.max(1, duration(options.pollMs, 25, 'pollMs'));
  const containment = options.containment ?? createNodeNativeProcessContainmentPort();
  try {
    const records = new Map<string, { latest: StoredWorkerLifecycleEvent; identity?: NativeProcessContainmentIdentity }>();
    for (const event of replayAll(db, workspace, options.sessionId)) {
      const current = records.get(event.workerId);
      const identity = processIdentity(event) ?? current?.identity;
      records.set(event.workerId, { latest: event, ...(identity === undefined ? {} : { identity }) });
    }
    const receipts: NativeWorkerOrphanReceipt[] = [];
    for (const record of [...records.values()].sort((left, right) => left.latest.sequence - right.latest.sequence)) {
      const event = record.latest;
      if (event.type === 'worker.terminal' || record.identity === undefined) continue;
      const termination = await terminateOwnedProcess(record.identity, containment, termGraceMs, killGraceMs, pollMs);
      if (termination === undefined) continue;
      appendWorkerLifecycleEvent(db, {
        packetId: recoveryPacketId(event), workspace, sessionId: event.sessionId, workerId: event.workerId, correlationId: event.correlationId,
        type: 'worker.terminal', redaction: event.redaction, createdAt: new Date((options.now ?? Date.now)()).toISOString(),
        payload: { outcome: 'failed', reason: ORPHAN_REASON, recovery: 'restart-orphan', termination },
      });
      receipts.push({ workerId: event.workerId, correlationId: event.correlationId, sessionId: event.sessionId, state: 'orphaned', outcome: 'failed', reason: ORPHAN_REASON, lastSequence: event.sequence, termination });
    }
    return Object.freeze(receipts.map((receipt) => Object.freeze(receipt)));
  } finally { db.close(); }
}
