import type { TrustSnapshot } from '../contracts/events.js';
import type { EffectSet } from '../contracts/tools.js';

export interface PolicyRequest { readonly operation: string; readonly trust: TrustSnapshot; readonly effects: EffectSet; readonly metadata: Readonly<Record<string, unknown>>; }
export type PolicyDecision = { readonly effect: 'allow' } | { readonly effect: 'deny'; readonly reason: string; readonly category: 'trust' | 'approval' | 'plan-policy' | 'peer-lock' | 'policy' };
export interface PolicyReceipt { readonly policy: string; readonly decision: PolicyDecision; readonly order: number; }
export type PolicyResult = PolicyDecision & { readonly receipts: readonly PolicyReceipt[] };

export class PolicyChain {
  readonly #policies: { readonly name: string; readonly evaluate: (request: PolicyRequest) => Promise<PolicyDecision> }[] = [];
  use(name: string, evaluate: (request: PolicyRequest) => Promise<PolicyDecision>): void {
    if (this.#policies.some((policy) => policy.name === name)) throw new Error(`Duplicate policy: ${name}`);
    this.#policies.push({ name, evaluate });
  }
  async evaluate(request: PolicyRequest): Promise<PolicyResult> {
    const receipts: PolicyReceipt[] = [];
    for (const [order, policy] of this.#policies.entries()) {
      const decision = await policy.evaluate(request);
      receipts.push({ policy: policy.name, decision, order });
      if (decision.effect === 'deny') return { ...decision, receipts };
    }
    return { effect: 'allow', receipts };
  }
}
