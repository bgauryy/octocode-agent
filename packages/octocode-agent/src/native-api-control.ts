import type { AgentRuntime } from '@octocodeai/agent-core';
import type {
  AgentControlEventByTypeV1,
  AgentControlSnapshotV1,
  AgentControlV1,
} from './api/v1.js';
import { projectControlEventV1 } from './native-public-events.js';

export function createAgentControlV1(
  runtime: AgentRuntime,
  ownedSubscriptions: Set<() => void> = new Set(),
): AgentControlV1 {
  return Object.freeze({
    submit: (input: string) => runtime.submit(input),
    cancel: (reason?: string) => runtime.cancel(reason),
    snapshot: (): AgentControlSnapshotV1 => {
      const snapshot = runtime.snapshot();
      return Object.freeze({
        schemaVersion: 1,
        state: snapshot.state,
        sessionId: String(snapshot.sessionId),
        activeTurn: snapshot.activeTurn,
        model: snapshot.model === null ? null : Object.freeze({ ...snapshot.model }),
        thinkingLevel: snapshot.thinkingLevel,
        usage: Object.freeze({ ...snapshot.usage }),
        revision: snapshot.revision,
      });
    },
    subscribe: (listener: (event: AgentControlEventByTypeV1) => void) => {
      let active = true;
      const unsubscribeRuntime = runtime.subscribe((event) => {
        try {
          listener(projectControlEventV1(event));
        } catch {
          // Public control observers are diagnostic and cannot alter runtime semantics.
        }
      });
      const unsubscribe = () => {
        if (!active) return;
        active = false;
        ownedSubscriptions.delete(unsubscribe);
        unsubscribeRuntime();
      };
      ownedSubscriptions.add(unsubscribe);
      return unsubscribe;
    },
    stop: () => runtime.stop(),
  });
}
