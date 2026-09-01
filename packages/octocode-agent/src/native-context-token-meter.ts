import type { ModelRequest, RuntimeContextTokenMeterPort } from '@octocodeai/agent-core';

import { NATIVE_ACTIVE_PLAN_CONTEXT_MAX_BYTES } from './native-plan-context.js';

const REQUEST_FRAMING_TOKEN_ALLOWANCE = 64;

/**
 * Provider-neutral upper bound: one token per UTF-8 byte, plus the maximum
 * transient plan context and a small request-framing allowance.
 */
export function nativeContextTokenUpperBound(request: ModelRequest): number {
  return new TextEncoder().encode(JSON.stringify(request)).byteLength
    + NATIVE_ACTIVE_PLAN_CONTEXT_MAX_BYTES
    + REQUEST_FRAMING_TOKEN_ALLOWANCE;
}

export const nativeContextTokenMeter: RuntimeContextTokenMeterPort = {
  measure(request, { signal }) {
    if (signal.aborted) throw signal.reason;
    return nativeContextTokenUpperBound(request);
  },
};
