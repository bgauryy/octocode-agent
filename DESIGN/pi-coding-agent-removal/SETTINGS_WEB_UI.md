# Unified settings HTML page

> Decision owner: `RFC.md` §Package boundaries. Operational order: `STEPS.md`. Contracts: `SCHEMAS_AND_TYPES.md`. Hook/plugin behavior: `HOOKS_AND_PLUGINS.md`. Native terminal relationship: `OPENTUI_TERMINAL_CORE.md`. Mandatory verification: `TEST_PLAN.md` and `KPI.md`.

## Decision

`settings.html` is the single human-facing settings control center owned by native `octocode-agent`. During the bounded comparison window, the frozen Pi oracle projects the same canonical settings through an adapter. All supported interactive configuration must be discoverable and editable in the native page. Terminal commands can open or deep-link it and automation can use the same typed settings service, but neither path owns a separate configuration contract.

The page must add first-class **Models**, **Hooks**, and **Plugins** sections. Models manages default provider/model selection, model availability and provenance, custom providers, custom models, compatibility options, and supported `models.json` sources. Hooks and Plugins manage discovery, provenance, exact-hash review, enablement, compatibility, permissions, contributions, health, and redacted diagnostics.

The HTML page is an adapter over canonical agent-core settings contracts. Agent core does not generate HTML, open a browser, depend on Pi, or import OpenTUI. The native launcher and Pi extension can both host the page by composing their adapters with the same `SettingsService`.

## Current-state evidence

The inspected 2026-08-28 working tree has two bounded implementations, neither of which satisfies this document's complete acceptance criteria.

Native `octocode-agent` now provides:

- one central slash-command catalog used by routing, help, and composer completion;
- `/settings [section]`, backed by a process-owned loopback-only server and deep-link anchors;
- Host and Origin validation, a per-page action token, POST-only bounded JSON, restrictive CSP, no-store and nosniff headers, HTML escaping, and an allowlisted public projection;
- typed, revision-checked global mutations for `theme` and `defaultModel`, classified as applying on the next session; and
- one core `SettingsRegistry`/`SettingsService` persistence bridge shared by runtime model selection and the native page, with rollback when the atomic file commit fails;
- a native extension-controller projection for hook and plugin discovery/activation counts; and
- focused controller, slash-command, launcher, desktop/mobile browser, and headless regression checks;
- a real browser save plus focus and ARIA checks, Anthropic/provider credential visibility, and a 390-by-844 layout check with no horizontal overflow.

This native slice is intentionally incomplete. The registry/service does not own launcher config commands, model-source transactions, automation, or the independent Pi-extension projection. Effective-catalog validation and the complete Models, MCP, Skills, backup, import, provenance, and recovery workflows remain open. Hooks and Plugins still need exact review, capability-grant, revoke, health, and contribution-management workflows. See `evidence/settings-control-center-2026-08-28.md` and `evidence/real-runtime-surface-eval-2026-08-28.md`.

The Pi extension starting point remains in `packages/octocode-pi-extension/src/tools/mcp-html.ts` and its settings documentation:

- `/settings` generates a loopback-only `settings.html` page.
- The page has eight navigation sections: Runtime, Commands, Connections, Add server, Discovery, Agent context, Skills, and Overrides.
- Its action union contains 11 string actions across MCP server/tool mutation, skill enablement, footer density, and permission level.
- It uses `renderOctocodePage`, a process-shared local server, same-origin checks, a 32-byte per-page action token, POST-only JSON actions, body limits, trust checks, containment checks, HTML escaping, redaction, and no-store responses.
- LSP finds `openMcpManager` at four reference sites across two production files and `renderMcpManagerPage` at six reference sites across production and tests.
- The inspected page lives under `$OCTOCODE_HOME/tmp/mcp/<workspace-digest>/settings.html`, which incorrectly couples the all-settings surface to MCP naming.
- `packages/octocode-agent/src/settings.ts` separately reads and writes Pi's `settings.json`. It allowlists only `defaultProvider`, `defaultModel`, and `theme`.
- LSP finds `setSetting` at three sites across `settings.ts` and `launcher.ts`. `readDefaultModel` has no production caller outside its declaration; its other four references are tests.
- The inspected production package sources contain no implemented `models.json` settings editor.

This RFC generalizes the existing page. It does not create a second settings site.

## Ownership and planned modules

| Planned boundary | Responsibility |
|---|---|
| `packages/octocode-agent-core/src/contracts/settings.ts` | Setting definitions, scopes, values, provenance, revisions, validation errors, mutations, and snapshots |
| `packages/octocode-agent-core/src/contracts/models.ts` | Provider, model, endpoint, API family, capability, cost, limit, compatibility, and model-source contracts |
| `packages/octocode-agent-core/src/settings/` | `SettingsRegistry`, `SettingsService`, precedence, validation, optimistic concurrency, and redacted projections |
| `packages/octocode-agent-core/src/models/` | Effective model catalog projection, source merging, default-model validation, and `models.json` import/export contracts |
| `packages/octocode-agent-core/src/hooks/` and `plugins/` | Redacted catalog/settings projections, trust state, enablement, compatibility, health, and typed mutations |
| `packages/octocode-agent/src/native-settings-service.ts` and `native-settings.ts` | Native core-service persistence bridge and transactional file adapter |
| `packages/octocode-agent/src/native-settings-page.ts` | HTML view, protected local action routes, section rendering, and client behavior |
| `packages/octocode-pi-extension/src/settings/` | Pi host settings/model source adapter plus `/settings` command registration |

Move/generalize `mcp-html.ts` into the settings adapter. MCP remains one section contributor rather than the page owner. Replace the temporary `tmp/mcp` output location with `$OCTOCODE_HOME/tmp/settings/<workspace-digest>/settings.html`; keep a tested compatibility redirect or opener mapping during the migration window.

## Settings registry

Every supported setting registers exactly once with metadata:

| Field | Purpose |
|---|---|
| Stable key and schema version | Prevent name collisions and support migrations |
| Section and order | Deterministic page organization |
| Value kind | Boolean, enum, string, integer, duration, path, secret reference, structured object, or list |
| Scope | Session, workspace, global, managed source, or read-only imported source |
| Default and effective value | Show actual behavior, not only stored overrides |
| Provenance | Default, environment, CLI, workspace, global, imported, runtime, or policy |
| Mutability and restart effect | Editable/read-only and immediate/new-session/restart-required behavior |
| Validator and normalizer | Parse unknown input before mutation |
| Visibility/redaction class | Public, sensitive metadata, secret reference, or never render |
| Owner and documentation link | Route support and review |

The page renders from the registry and reports unrendered registered settings as a test failure. A new setting cannot ship only in a command, environment parser, JSON file, or hidden runtime field unless it is explicitly classified as machine-only or secret-only with an owner-approved reason.

## Page information architecture

| Section | Required content |
|---|---|
| Overview | Health, effective scope, pending restart/new-session changes, validation warnings, and section counts |
| Runtime | Permission policy, footer density, execution/runtime choices, and session-scoped controls |
| Appearance | Theme and terminal-display settings; OpenTUI-specific rendering options remain adapter settings |
| Models | Default provider/model, effective catalog, custom providers/models, source provenance, refresh/import/export, and `models.json` editor |
| Hooks | Codex/Octocode sources, event/matcher/handler summaries, managed/trust state, exact-hash review, enablement, test, and redacted execution health |
| Plugins | Identity/version/API compatibility, activation events, permissions, contributions, trust, enablement, update/unload, and health |
| Commands | Live read-only command inventory |
| Connections | MCP servers and tools |
| Add server | Structured MCP editor |
| Discovery | Imported configuration sources and warnings |
| Agent context | Prompt/catalog readiness and new-session effects |
| Skills | Skill inventory and enablement |
| Overrides | Effective normalized values and provenance, always redacted |
| Diagnostics | Read-only validation, file paths, revisions, refresh state, and safe recovery actions |

Navigation and deep links include `#models`, `#hooks`, and `#plugins`; `/settings models`, `/settings hooks`, and `/settings plugins` open those sections. `/settings` opens Overview rather than defaulting to Skills. Existing `/mcp` and section aliases keep their focused deep links during compatibility.

## Models section

### Effective catalog

Show searchable/filterable model cards or rows with:

- provider ID, model ID, display name, and API family;
- source and scope;
- enabled/available/default state;
- authentication readiness without revealing credentials;
- base endpoint with user info, query, and fragment redacted;
- context window and output-token limit when known;
- input/output modalities and tool/thinking capabilities when known;
- supported thinking levels or reasoning modes;
- cost metadata with currency/unit labels when known;
- compatibility flags and warnings;
- whether a new session or catalog refresh is required.

Unknown values remain explicitly unknown; the page must not invent limits, prices, or capabilities.

### Default model

The default model control writes provider and model as one validated transaction. It cannot persist a provider/model pair that the effective catalog cannot resolve unless the same mutation also creates a valid custom entry. The page shows the winning provenance and any CLI/environment override that prevents the stored value from becoming effective.

### Custom provider and model editor

Use structured fields for supported schema members. At minimum:

- provider/model IDs and display names;
- API family;
- base URL;
- environment-variable or credential reference;
- optional headers as environment references;
- model limits, modalities, tool support, and reasoning capability;
- compatibility flags;
- workspace/global scope;
- enabled state.

Never accept or display a raw API key in the normal form. Credential references and OAuth/OS credential-store flows are preferred. If legacy input contains an inline secret, show only that a secret value exists and require an explicit secure migration or replacement action.

### `models.json` sources

The page lists every supported source with exact path, scope, precedence, owner, revision/hash, parse status, writability, and effective contribution. The target native sources are:

- global: `$OCTOCODE_HOME/agent/models.json`;
- workspace: `$OCTOCODE_HOME/agent/workspaces/<workspace-key>/models.json`.

Legacy Pi sources such as `~/.pi/agent/models.json` and workspace `.pi/models.json` remain compatibility inputs. During the compatibility window, the Pi-extension adapter can expose a Pi-owned source as editable only when the active Pi host contract supports safe mutation. Otherwise, the page presents it read-only with **Import into Octocode**, a semantic diff, and no source modification.

The advanced JSON view:

1. starts from a redacted serialization;
2. never serializes credential values into HTML;
3. validates syntax and the full runtime schema before enabling Save;
4. shows a semantic diff and affected effective models;
5. uses an expected revision/hash to reject stale writes;
6. preserves supported unknown fields or blocks with an explicit incompatibility error;
7. writes atomically through a temporary sibling plus rename;
8. preserves file permissions and creates a recoverable backup according to policy;
9. never rewrites imported read-only sources;
10. refreshes the catalog and marks frozen sessions stale after commit.

Deleting a provider/model requires dependency checks for the active/default model, model roles, saved session metadata, automation, and fallback chains. A destructive mutation shows impact and requires explicit confirmation.

## Hooks and Plugins sections

These sections consume redacted catalog projections defined by `HOOKS_AND_PLUGINS.md`; the browser never receives executable handler objects, raw commands, environment values, prompt/tool payloads, or secrets. Each item shows exact source and scope, managed state, raw/normalized review hashes, trust and enablement as separate states, compatibility, requested/granted permissions, contribution inventory, last safe result, timing, and bounded failures.

Mutations are typed actions with expected revisions: review exact definition, enable/disable, approve/deny capabilities, request safe reload, and run a synthetic validation/test. Installing or enabling a plugin never trusts its hooks automatically. A changed hash returns to review-required. Managed definitions are visible but read-only. Unsupported Codex events/handler types and unknown plugin contributions remain visible with a reason rather than disappearing.

Review renders a semantic diff of event, matcher, handler type, path/command digest, timeout, async state, permissions, activation events, and contributions. Test execution uses synthetic data and cannot call effectful tools, model providers, or arbitrary production MCP endpoints. Update/unload shows active leases and waits, cancels, or refuses according to the canonical lifecycle policy.

## Source precedence and effective values

Agent core owns one documented precedence function. The initial order is resolved during the contract phase from observed native/Pi behavior and must cover:

1. explicit session or invocation override;
2. approved environment override;
3. workspace canonical setting;
4. global canonical setting;
5. imported compatibility source;
6. product default.

The page always distinguishes stored value from effective value. Every row shows why a higher-priority source wins. Mutation responses return the new stored value, effective value, provenance, restart/new-session effect, and revision.

## Mutation protocol

All changes use versioned typed actions over the existing protected loopback server:

```ts
type SettingsMutation = {
  protocolVersion: 1;
  requestId: string;
  action: 'set' | 'unset' | 'upsert-model' | 'remove-model' | 'upsert-provider' | 'remove-provider' | 'replace-model-source' | 'import-model-source' | 'refresh-models';
  scope: 'session' | 'workspace' | 'global';
  expectedRevision: string;
  payload: unknown;
};
```

The server parses `unknown`, resolves the registered action schema, checks origin/token/body size/trust/path/revision/policy, computes a redacted preview, commits through the owning store, refreshes derived catalogs, and returns a typed result. UI code never writes files directly.

Concurrent tabs or external edits produce a typed conflict with Reload and Compare actions. The server does not apply last-write-wins silently.

## Security requirements

Retain every current `settings.html` protection and add:

- a restrictive Content Security Policy with no remote script/style execution;
- no secret values in HTML, DOM data attributes, JavaScript state, URLs, logs, diffs, backups, or error payloads;
- schema-specific request size and collection-count limits;
- URL protocol and loopback/private-network warnings for model endpoints;
- environment/header name validation;
- project trust before workspace writes or imported-file access;
- lexical plus realpath containment and symlink rejection;
- file permission checks and safe creation mode;
- confirmation and impact preview for destructive model/provider removal;
- audit receipts containing only setting key, scope, revision, outcome, and redacted impact;
- disabled browser caching and no third-party requests.

The action token authorizes only the generated page/session and is rotated when the page is regenerated. Browser opening alone never grants a workspace trust transition.

## Refresh and lifecycle

Successful changes emit a typed settings-changed event. Consumers subscribe through agent core and invalidate only the affected derived state. The mutation result classifies application timing:

- immediate;
- next model request;
- next session;
- process restart;
- manual reconnect/refresh.

Model catalog mutations validate and rebuild the effective catalog before success. If rebuild fails, the transaction rolls back. Changing the active/default model never mutates an already-running request. A frozen prompt/session displays a new-session warning when required.

## Test strategy

| Layer | Required proof |
|---|---|
| Registry unit | Every registered setting renders or has an approved machine/secret-only classification; keys, scope, defaults, precedence, and versions are unique/deterministic |
| Schema/property | Valid round trips, malformed rejection, unknown-field policy, size/count limits, URL/env/header validation, and redaction |
| Store/fault | Atomic write, stale revision, concurrent tab, external edit, partial write, permission failure, symlink, rollback, backup, and restart replay |
| Models | Default transaction, provider/model CRUD, catalog merge/precedence, legacy import, semantic diff, dependency checks, refresh, and frozen-session warning |
| HTML | Every section/deep link, accessibility, keyboard navigation, responsive layout, escaping, CSP, no secret DOM state, and typed action error preservation |
| Security | DNS rebinding, origin/token confusion, CSRF, traversal, symlink, oversized body, secret injection, malicious model metadata, and untrusted workspace |
| Host conformance | Native page and supported Pi-extension page expose the same canonical settings; host-only settings are explicitly classified |
| End-to-end | `/settings`, `/settings models`, save/reload/conflict/import/recovery, native launch, Pi-extension host, and noninteractive automation |

Tests use synthetic credentials and scan generated HTML, logs, diffs, backups, and receipts for secret markers.

## Migration and rollback

1. Freeze the current eight sections, 11 actions, security behavior, and page tests.
2. Introduce agent-core settings/model contracts and wrap the current page without changing behavior.
3. Rename/generalize the implementation and output directory while preserving opener aliases.
4. Add registry-driven Runtime and Appearance sections.
5. Add the Models section read-only with full provenance and redaction.
6. Enable structured mutations, revision conflicts, atomic writes, and recovery.
7. Enable advanced validated JSON editing and legacy Pi import.
8. Move launcher `config get/set/list` onto the same service.
9. Remove duplicate direct settings writers after AST/LSP callers reach zero.

Before the native-default gate, rollback restores the prior page/service adapter and host selector without rewriting settings/model sources. After native dependency removal, rollback uses the prior release artifact. Backups and source revisions remain available for explicit recovery; rollback never silently overwrites user configuration.

## Acceptance criteria

- `/settings` is the only human-facing settings control center.
- `/settings models` opens a complete Models section.
- Every supported editable setting appears in the registry and page.
- Default provider/model and model-source mutations are transactional and revision-safe.
- `models.json` sources show provenance, precedence, validation, and effective contribution.
- Generated HTML, client state, responses, logs, diffs, backups, and receipts contain no secret values.
- Native and supported Pi-extension hosts pass the same settings conformance suite.
- Agent core has no HTML, browser, Pi, OpenTUI, or filesystem implementation dependency.
- Direct legacy settings writers have zero unclassified production callers at completion.
