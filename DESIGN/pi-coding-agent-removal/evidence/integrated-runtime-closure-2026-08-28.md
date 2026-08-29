# Integrated runtime closure receipt — 2026-08-28

Status: accepted dirty-tree implementation increment; release remains `HOLD`.

## Scope verified

- replacement fixed-session runtimes for create, resume, switch, fork, name,
  export, and same-workspace navigation;
- persisted manual and automatic threshold compaction with bounded retry behavior;
- session-owned MCP catalogs, elicitation, durable Tasks, provenance, enablement,
  and registry-owned hook execution;
- contained Skill discovery, loading, refresh, lifecycle, provenance, and settings
  controls;
- bounded command, MCP, and asynchronous hook execution plus transactional plugin
  review and grants;
- owned worker recovery, physical worktree containment, dynamic RPC/ACP session
  projection, and official ACP permission requests;
- protected settings controls for providers, MCP, Skills, plugins, and portable
  export/import/reset;
- OpenAI Chat, Responses, and Anthropic credential-free loopback lifecycle paths.

## Commands and observed results

- `yarn test` — PASS: 3,484 tests passed; 16 OpenTUI native-FFI cases skipped by
  the ordinary environment gate.
- `yarn typecheck && yarn lint && yarn build` — PASS.
- `node packages/octocode-agent/out/octocode-agent.mjs --help` — PASS.
- `node packages/octocode-agent/out/octocode-agent.mjs config list --json` — PASS.
- `node packages/octocode-agent/out/octocode-agent.mjs sessions --json` — PASS.
- `npx octocode context --compact` and live tool-schema discovery — PASS.
- In-app browser smoke — PASS: settings page navigation, labels, provider/MCP/Skill
  controls, and a protected MCP capability mutation reported `Capability updated.`
- `NODE_OPTIONS=--experimental-ffi yarn tsx
  packages/octocode-agent/tests/opentui-pty-smoke.mjs` — PASS with exact
  `OCTOCODE_PTY_RESTORED` marker.
- `git diff --check` — PASS after integration.

## Limits

This is not release or parity approval. Still required: a named clean candidate and
frozen Pi oracle; complete durable graph/import/overflow/corruption/crash coverage;
composite-effect and Awareness peer-lock proof; credentialed providers and broader
provider policy; full independent ACP/MCP/client and cross-host conformance; complete
configuration writers; supported-platform terminal, browser, and screen-reader
matrices; quantitative canary thresholds; rollback rehearsal; observation window;
clean packed install/upgrade; and final zero-reference Pi removal.
