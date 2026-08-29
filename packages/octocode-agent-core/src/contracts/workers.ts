import type { RedactionClass } from './errors.js';
import type { CorrelationId, PacketId, SessionId, WorkerId } from './identity.js';

export interface WorkerCapabilities {
  readonly tools: readonly string[];
  readonly models: readonly { readonly providerId: string; readonly modelId: string }[];
  readonly maxTurns: number;
}

interface WorkerPacketEnvelope {
  readonly schemaVersion: 1;
  readonly packetId: PacketId;
  readonly workerId: WorkerId;
  readonly correlationId: CorrelationId;
  readonly sessionId: SessionId;
  readonly redaction: RedactionClass;
}

export interface WorkerSpawnPacket extends WorkerPacketEnvelope {
  readonly type: 'worker.spawn';
  readonly prompt: string;
  readonly promptSnapshotId: string;
  readonly workspace: { readonly mode: 'shared' } | { readonly mode: 'worktree'; readonly path: string; readonly baseRevision: string };
  readonly capabilities: WorkerCapabilities;
}

export type WorkerPacket = WorkerPacketEnvelope & {
  readonly type: 'worker.send' | 'worker.steer' | 'worker.follow-up';
  readonly text: string;
};

export type WorkerTerminalOutcome = 'succeeded' | 'failed' | 'aborted' | 'killed';
export type WorkerTerminalPacket = WorkerPacketEnvelope & {
  readonly type: 'worker.terminal';
  readonly outcome: WorkerTerminalOutcome;
  readonly handback?: unknown;
  readonly reason?: string;
};

export type WorkerState = 'queued' | 'starting' | 'running' | 'aborting' | 'killing' | WorkerTerminalOutcome;
export interface WorkerStateEntry extends WorkerPacketEnvelope {
  readonly type: 'worker.state';
  readonly state: WorkerState;
}
export type WorkerLedgerEntry = WorkerSpawnPacket | WorkerPacket | WorkerStateEntry | WorkerTerminalPacket;

export interface WorkerHandle {
  readonly completion: Promise<WorkerTerminalPacket>;
  send(packet: WorkerPacket): Promise<void>;
  abort(reason: string): Promise<void>;
  kill(reason: string): Promise<void>;
}

export interface WorkerPort {
  spawn(packet: WorkerSpawnPacket, signal: AbortSignal): Promise<WorkerHandle>;
}

export interface WorkerLedgerPort {
  append(entry: WorkerLedgerEntry): Promise<void>;
}

export interface WorkerWorktreePort {
  prepare(packet: WorkerSpawnPacket, signal: AbortSignal): Promise<void>;
  release(packet: WorkerSpawnPacket, terminal: WorkerTerminalPacket): Promise<void>;
}

export interface WorkerSnapshot {
  readonly workerId: WorkerId;
  readonly correlationId: CorrelationId;
  readonly sessionId: SessionId;
  readonly state: WorkerState;
  readonly queueDepth: number;
  readonly capabilities: WorkerCapabilities;
  readonly terminal?: WorkerTerminalPacket;
}

export interface WorkerSupervisorSnapshot {
  readonly state: 'running' | 'stopping' | 'stopped' | 'failed';
  readonly active: number;
  readonly queued: number;
  readonly maxActive: number;
}

export type WorkerCommand =
  | { readonly type: 'spawn'; readonly packet: WorkerSpawnPacket }
  | { readonly type: 'list' }
  | { readonly type: 'status' | 'wait' | 'abort' | 'kill'; readonly workerId: WorkerId; readonly reason?: string }
  | { readonly type: 'send' | 'steer' | 'follow-up'; readonly packet: WorkerPacket }
  | { readonly type: 'shutdown'; readonly reason?: string };

export interface WorkerController {
  execute(command: WorkerCommand): Promise<unknown>;
}
