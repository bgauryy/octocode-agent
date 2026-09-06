import type { RuntimeEvent } from '@octocodeai/agent-core';
import type { RuntimeObservation } from '@octocodeai/octocode-awareness';

interface NativeModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

export interface NativePhysiologyOptions {
  readonly initialModel: NativeModelRef;
  /** Returns core's admission budget for this exact active model, or unknown. */
  readonly resolveInputLimit: (model: NativeModelRef) => number | undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readModelRef(value: unknown): NativeModelRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.providerId === 'string' && candidate.providerId.length > 0 &&
    typeof candidate.modelId === 'string' && candidate.modelId.length > 0
    ? { providerId: candidate.providerId, modelId: candidate.modelId }
    : undefined;
}

/** Fixed-size, redacted projection of live core receipts. No payload bodies or call identifiers retained. */
export function createNativePhysiology(options: NativePhysiologyOptions) {
  let context: RuntimeObservation['context'];
  let activeModel: NativeModelRef | undefined = options.initialModel;
  const outcomes: Array<'success' | 'failed' | 'cancelled' | 'blocked'> = [];
  const controls: RuntimeObservation['controls'] = {
    owner: 'agent_core', compactions_committed: 0, compactions_failed: 0, retries_scheduled: 0,
  };
  return {
    observe(event: RuntimeEvent): void {
      switch (event.type) {
        case 'context.usage-changed': {
          const currentTokens = event.payload.currentContextTokens;
          if (!isCount(currentTokens) || !isCount(event.timestamp)) {
            context = undefined;
            break;
          }
          const inputLimit = activeModel === undefined
            ? undefined
            : options.resolveInputLimit(activeModel);
          if (!isCount(inputLimit) || inputLimit === 0) {
            context = { current_tokens: currentTokens, measured_at: event.timestamp };
            break;
          }
          const remaining = Math.max(0, inputLimit - currentTokens);
          context = {
            current_tokens: currentTokens,
            measured_at: event.timestamp,
            input_limit_tokens: inputLimit,
            remaining_input_tokens: remaining,
            saturation_basis_points: Math.min(10_000, Math.floor((currentTokens / inputLimit) * 10_000)),
          };
          break;
        }
        case 'model.selected':
          delete controls.provider_attempt;
          delete controls.provider_max_attempts;
          // Never retain the former model's budget if this event is malformed.
          activeModel = readModelRef(event.payload);
          context = undefined;
          break;
        case 'runtime.stopped':
        case 'context.appended':
        case 'context.compacted':
        case 'input.received':
          // A changed context invalidates occupancy until core publishes a new measurement.
          context = undefined;
          if (event.type === 'context.compacted') controls.compactions_committed += 1;
          break;
        case 'context.compaction-failed':
          controls.compactions_failed += 1;
          break;
        case 'provider.request-started':
          context = undefined;
          controls.provider_attempt = event.payload.attempt;
          controls.provider_max_attempts = event.payload.maxAttempts;
          break;
        case 'provider.failed':
          if (event.payload.retrying === true) controls.retries_scheduled += 1;
          break;
        case 'tool.ended':
          context = undefined;
          // Attend must not erase its own failure signal merely through repeated status reads.
          if (event.payload.name === 'awareness') break;
          outcomes.push(event.payload.outcome === 'error' ? 'failed' : event.payload.outcome);
          if (outcomes.length > 32) outcomes.shift();
          break;
      }
    },
    /** A receipt that did not persist cannot update telemetry; discard any dependent projection. */
    invalidateUnpersistedReceipt(event: RuntimeEvent): void {
      context = undefined;
      // Core changes its selected model before emitting. Its failed receipt is not evidence
      // that native telemetry may use either the former or proposed model's input budget.
      if (event.type === 'model.selected') activeModel = undefined;
    },
    snapshot(): RuntimeObservation {
      return { schema_version: 1, source: 'native_runtime',
        ...(context === undefined ? {} : { context: { ...context } }),
        tools: { window: 32, observed: outcomes.length,
          failed: outcomes.filter(value => value === 'failed').length,
          cancelled: outcomes.filter(value => value === 'cancelled').length,
          blocked: outcomes.filter(value => value === 'blocked').length },
        controls: { ...controls },
      };
    },
  };
}
