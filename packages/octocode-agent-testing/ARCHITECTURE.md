# Agent testing architecture

`@octocodeai/agent-testing` is a test-only conformance package. It depends on
core contracts, records normalized evidence, and never owns production behavior.

## Ownership

- `src/index.ts` re-exports the public conformance and release-closure surface.
- `src/host-conformance.ts` owns the canonical scenario IDs, comparison rules,
  scenario applicability, trace hashing, bounded observations, divergence
  reporting, and unsupported-result semantics.
- `src/production-host-adapters.ts` owns the test-only adapter that invokes
  caller-supplied native production entrypoints.
- `src/release-closure.ts` owns the fail-closed, test-only evaluator for signed
  completion receipts. It can report `GO`, `HOLD`, or `ROLLBACK`; it never
  creates evidence or changes production rollout state.

## Conformance flow

```text
canonical scenario from the 14-scenario matrix
  -> synthetic runner fixture or attributed production adapter
  -> ordered event, effect, and observation receipt
  -> semantics-preserving normalization
  -> trace, effect, and separate observation hashes
  -> matched, host-covered, diverged, or unsupported result
```

Core owns runtime event schemas. This package records and compares them; it does
not redefine them. Synthetic adapters validate the comparison machinery only.
Cross-host production parity is green only when both real composition roots return
correctly attributed evidence for the same scenario; the package currently ships
only the native production adapter. Host-specific coverage follows
the explicit applicability contract. Unsupported is a failing coverage result, not
a neutral skip.

Scenario applicability is explicit. Cross-host scenarios compare normalized trace
and effect evidence. A host-specific scenario executes exactly one named host,
records attributed coverage, and never fabricates an empty or matching peer trace.
Observations preserve bounded host facts verbatim but do not change parity. For
persistence restart, the semantic event asserts deterministic projection while
observations retain native's ordered lifecycle entries.

## Dependency rules

- Production packages must not import this package.
- This package must not import Pi SDK packages or the Pi extension package.
- Synthetic handlers test the conformance runner, not host parity.
- A cross-host production scenario passes only when both adapters exercise the real
  composition path and produce matching trace and effect-ledger evidence. An
  explicitly host-specific scenario passes only with attributed evidence from its
  named host.
- Production scenario probes return attributed event, effect, and observation
  receipts. The testing package rejects cross-attributed receipts and never
  supplies a host harness or runtime double to a production probe.
- Unsupported scenarios remain failures with an explicit reason; they must not
  be converted to synthetic success.

The current production support matrix is executable in
`tests/production-host-conformance.test.ts`: the native adapter supports and
executes all 14 canonical scenarios through the built CLI and production composition.
Program-level completion gates live in
[`DESIGN/LEFTOVERS.md`](../../DESIGN/LEFTOVERS.md).
The release-closure evaluator requires exactly one independently reviewed,
signature-verified receipt for every ledger gate, all bound to one clean commit
and artifact digest. A time-bounded, sufficiently sized canary with explicit
metrics is mandatory. Missing or unsupported evidence yields `HOLD`; a breached
canary threshold yields `ROLLBACK`.
