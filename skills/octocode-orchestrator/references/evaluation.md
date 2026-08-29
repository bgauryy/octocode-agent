# Evaluation And TDD

Load when EXECUTE or VERIFY needs an improvement loop, held-out behavior check, or must judge whether an orchestration strategy improved outcomes. Why: ordinary regression tests cover normal ship checks; strategy and behavioral claims need a frozen outcome comparison.

## TDD for behavior changes

Select or write a failing behavioral case before changing code or instructions. Make the smallest change, run the same test, then run proportionate regression checks. A rename, explanation, read-only audit, or ordinary configuration edit may use an existing focused check instead of inventing a failing test.

## Eval contract before strategy mutation

Record:

- user-visible goal and one primary KPI with direction, baseline, and target;
- up to three leading indicators;
- fixed time/token/trial budget;
- counter-metric guardrails;
- held-out cases not used to design the change;
- binary decision rule: accept only when the primary reaches target and guardrails hold.

Make the smallest strategy change, run the same sensor, and keep or discard from comparable results. Do not edit cases or graders during an experiment to make the subject pass.

Use deterministic anchors first: test exits, type diagnostics, build exits, schema validation, and artifact inspection. Use a fresh-context critic for judgment dimensions deterministic checks cannot measure.

For multi-agent work, measure the user-visible result at the graph boundary; use worker scores, latency, token cost, packet completeness, collisions, and verifier freshness as leading measures or guardrails—not as the primary outcome.

Next: load [completion](completion.md) for acceptance and reporting; if shared state affected the run, load [Awareness](awareness.md) before closing.
