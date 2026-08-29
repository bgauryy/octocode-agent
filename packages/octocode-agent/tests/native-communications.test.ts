import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, RuntimeCommand, RuntimeSnapshot } from '@octocodeai/agent-core';
import { openAwareness, type AwarenessEventStore, type InboundDecision, type OutboxEventV1 } from '@octocodeai/octocode-awareness';
import { withNativeSessionCommunication } from '../src/native-communications.js';

const workspace = '/work/repo';

function peerEvent(sequence: number): OutboxEventV1 {
  return {
    sequence,
    version: 1,
    eventId: `evt-${sequence}`,
    workspace,
    sessionId: 'child-session',
    correlationId: 'parent-child-1',
    type: 'peer.message',
    actor: { kind: 'agent', id: 'child-agent' },
    provenance: { source: 'peer', trust: 'attributed-data' },
    aggregate: { kind: 'message', id: `msg-${sequence}` },
    createdAt: '2026-08-28T00:00:00.000Z',
    payload: {
      messageId: `msg-${sequence}`,
      fromAgentId: 'child-agent',
      toAgentId: 'native:parent-session',
      topic: 'HANDOFF',
      text: `verified result ${sequence}`,
    },
  };
}

describe('native session communication bridge', () => {
  it('persists a targeted subagent event before ordered acknowledgement and does not redeliver it', async () => {
    const events = [peerEvent(1)];
    let cursor = 0;
    const acknowledgements: Array<{ eventId: string; decision: InboundDecision }> = [];
    const store: AwarenessEventStore = {
      listEvents: ({ limit }) => events.filter((event) => event.sequence > cursor).slice(0, limit),
      acknowledgeEvent: ({ eventId, decision }) => {
        expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'context.append', eventId }));
        acknowledgements.push({ eventId, decision });
        cursor = events.find((event) => event.eventId === eventId)!.sequence;
        return { sequence: cursor, decision, duplicate: false };
      },
      getConsumerCursor: () => cursor,
      close: vi.fn(),
    };
    const execute = vi.fn(async (command: RuntimeCommand) => ({ ok: true as const, data: command }));
    const runtime: AgentRuntime = {
      start: vi.fn(async () => undefined),
      submit: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      execute,
      snapshot: () => ({ state: 'ready' }) as RuntimeSnapshot,
      subscribe: () => () => undefined,
      stop: vi.fn(async () => undefined),
    };
    const wrapped = withNativeSessionCommunication(runtime, {
      workspace,
      sessionId: 'parent-session',
      agentId: 'native:parent-session',
      openStore: () => store,
    });

    await wrapped.start();
    await wrapped.submit('continue');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      type: 'context.append',
      eventId: 'evt-1',
      text: '[peer:child-agent; class:handoff; authority:data]\nverified result 1',
      provenance: 'peer-attributed-data',
    });
    expect(acknowledgements).toEqual([{ eventId: 'evt-1', decision: 'accept' }]);
  });

  it('runs a real SQLite parent-child handoff through the headless session bridge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-bus-'));
    const dbPath = path.join(root, 'awareness.sqlite');
    const liveWorkspace = path.join(root, 'workspace');
    fs.mkdirSync(liveWorkspace);
    const awareness = openAwareness({ workspace: liveWorkspace, dbPath });
    try {
      awareness.sendMessage({
        fromAgentId: 'child-agent',
        toAgentId: 'native:parent-session',
        topic: 'HANDOFF',
        text: 'child verification complete',
      });
    } finally {
      awareness.close();
    }
    const commands: RuntimeCommand[] = [];
    const runtime: AgentRuntime = {
      start: vi.fn(async () => undefined),
      submit: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      execute: vi.fn(async (command) => { commands.push(command); return { ok: true as const }; }),
      snapshot: () => ({ state: 'ready' }) as RuntimeSnapshot,
      subscribe: () => () => undefined,
      stop: vi.fn(async () => undefined),
    };
    const wrapped = withNativeSessionCommunication(runtime, {
      workspace: liveWorkspace,
      sessionId: 'parent-session',
      agentId: 'native:parent-session',
      openStore: (openedWorkspace) => openAwareness({ workspace: openedWorkspace, dbPath }),
    });

    await wrapped.start();
    await wrapped.start();

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: 'context.append',
      text: '[peer:child-agent; class:handoff; authority:data]\nchild verification complete',
      provenance: 'peer-attributed-data',
    });
    const verify = openAwareness({ workspace: liveWorkspace, dbPath });
    try {
      expect(verify.listEvents({ consumerId: 'native-session:parent-session' })).toHaveLength(0);
      expect(verify.getConsumerCursor('native-session:parent-session')).toBeGreaterThan(0);
    } finally {
      verify.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
