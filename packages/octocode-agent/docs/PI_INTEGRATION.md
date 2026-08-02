# octocode-agent × Pi — integration research & design

How the `octocode-agent` platform drives the Pi host, and how the Octocode harness
(`@octocodeai/pi-extension`, **the core**) plugs in. All Pi facts below are verified
against the live docs of `@earendil-works/pi-coding-agent` (npm `0.80.3`, repo
`earendil-works/pi`, `packages/coding-agent/docs/*`). The launcher pins Pi to `0.80.3`
so the documented SDK/extension behavior and runtime dependency stay aligned.

---

## 1. What Pi is (and its design philosophy)

Pi is a small coding-agent CLI: `read, bash, edit, write` (+ optional `grep, find, ls`)
tools, session management, a TUI, and provider-agnostic model access. Its stated
principle (`usage.md` §Design Principles): **keep the core small; push everything
workflow-specific into extensions, skills, prompt templates, themes, and packages.**
It deliberately ships *no* built-in MCP, sub-agents, permission popups, plan mode,
to-dos, or background bash — you add those as extensions/packages.

That is exactly why octocode-agent is a thin platform over Pi rather than a fork: the
harness (prompt + skills + tools + memory) is a Pi *package*, and octocode-agent is the
launcher that boots Pi with that package as the authoritative core.

**Layers:**
- `octocode-agent` — platform/launcher (this package). Depends on Pi + the core; owns the branded launch and the update path.
- `@octocodeai/pi-extension` — **the core**. A Pi package: `pi.extensions` (the harness wiring) + bundled research skills + the bundled system prompt.
- `@earendil-works/pi-coding-agent` — the Pi host runtime. An internal detail of the platform.

---

## 2. How octocode-agent launches Pi

### Current strategy — SDK embed first, subprocess fallback

The default path imports Pi's documented SDK and passes the Octocode extension **factory**
directly to Pi's resource loader — no subprocess and no `-e`:

```ts
import {
  createAgentSessionRuntime, createAgentSessionServices,
  createAgentSessionFromServices, InteractiveMode, getAgentDir, SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createOctocodePiExtension } from "@octocodeai/pi-extension";

const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({
    cwd,
    agentDir: getAgentDir(),
    resourceLoaderOptions: {
      extensionFactories: [createOctocodePiExtension({ promptMode: "octocode-first" })],
    },
  });
  return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
           services, diagnostics: services.diagnostics };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(), agentDir: getAgentDir(), sessionManager: SessionManager.create(process.cwd()),
});
await new InteractiveMode(runtime, { /* initialMessage, … */ }).run();
```

The launcher sets `OCTOCODE_PROMPT_MODE=octocode-first` + `OCTOCODE_AGENT=1`; the core
reads the mode with no divergent harness code path. Legacy `replace` is accepted as an alias.
Supported SDK-level args include `--print`, `--mode rpc`, `--continue`, `--session`,
`--no-session`, `--name`, and an initial message. `OCTOCODE_AGENT_CLEAN=1` and
`OCTOCODE_AGENT_NO_CONTEXT_FILES=1` remain honored by the subprocess fallback.

If SDK import or runtime creation fails, the launcher falls back to:

```
pi --no-extensions -e <coreRoot> [--no-skills] [passthrough…]
```

- `-e, --extension <source>` loads an extension from a **path, npm, or git** *for that
  run only* — no global settings write, no trust prompt for our own package
  (`usage.md` §Resource Options; `packages.md` §Install/`-e`).
- `-e <directory>` loads by **package rules**, so one flag brings the extension **and its
  bundled skills** (`packages.md` §Local Paths). We point it at the resolved package root
  of `@octocodeai/pi-extension`.
- `OCTOCODE_AGENT_EXTENSION_SPEC` overrides the fallback spec (`npm:…@ver`, `git:…`, path).
- Project `AGENTS.md`/`CLAUDE.md` context files load by default so repository rules remain authoritative.
  `OCTOCODE_AGENT_NO_CONTEXT_FILES=1` or `OCTOCODE_AGENT_CLEAN=1` adds `--no-context-files`.
- `OCTOCODE_AGENT_CLEAN=1` adds `--no-skills --no-context-files` → deterministic harness-only mode.

This replaced an earlier `pi install <spec>` approach, which mutated global settings and
required trust. Pi bin resolution is still data-driven from `@earendil-works/pi-coding-agent`'s
`package.json` `bin` field for the fallback, so a Pi version bump can't break a hardcoded path.

**Why this is the platform path:** `extensionFactories` takes `(pi) => …` functions — exactly
what `createOctocodePiExtension({promptMode:'octocode-first'})` returns. We get in-process
startup, direct runtime control, and the same core package that still works under plain
`pi install npm:@octocodeai/pi-extension` in append mode.

---

## 3. UX (what the user sees)

Interactive TUI has four areas (`usage.md` §Interactive Mode): **startup header**
(shortcuts, loaded context files, prompt templates, skills, extensions), **messages**,
**editor** (border color = thinking level), **footer** (cwd, session name, token/cost,
context usage, model).

Extensions drive UX through `ctx.ui` (`extensions.md` §ctx.ui): `notify`, `setStatus`,
`setWorkingIndicator`, `setWorkingMessage`, `setFooter`, `setHiddenThinkingLabel`,
plus dialogs, widgets, autocomplete, and custom components. The core already uses
`ctx.ui.notify`/`confirm`. Branding beyond this (a custom header replacing Pi's logo)
needs the SDK/settings path — cosmetic and deferred (RFC `quietStartup`).

Editor niceties the agent inherits for free: `@`-file references, `!cmd`/`!!cmd` shell,
image paste, message queue (Enter = steer, Alt+Enter = follow-up).

---

## 4. Commands

Pi's built-in slash commands (`usage.md` §Slash Commands): `/login`, `/logout`,
`/model`, `/scoped-models`, `/settings`, `/resume`, `/new`, `/name`, `/session`, `/tree`,
`/trust`, `/fork`, `/clone`, `/compact [prompt]`, `/copy`, `/export`, `/import`, `/share`,
`/reload`, `/hotkeys`, `/changelog`, `/quit`. Skills appear as `/skill:name`; prompt
templates as `/templatename`.

**Delta vs RFC (0.79.4 → 0.80.x):** the RFC claimed built-ins win and *hide* colliding
extension commands. On 0.80.x, `registerCommand` **keeps all** same-named commands and
assigns numeric suffixes in load order (`/review:1`, `/review:2`) (`extensions.md`
§registerCommand). Implication: name collisions no longer silently drop our command — but
the `/octocode` umbrella is still the right UX (one discoverable namespace) and avoids
`:1` suffixes. `/new` (not `/clear`) remains Pi's native wipe; Octocode exposes reset/compaction through the guarded `manage_context` tool and the private `_octocode-clear-context-impl` command.

The core registers: `/octocode`, `/octocode-status`, `/octocode-harness`, `/octocode-agents`, `/octocode-cron` (`/cron` alias), `/octocode-mcp` (`/mcp` alias), `/octocode-setup`, and `/octocode-skills-update`. Model-facing support tools include `web`, `chromeDebug`, `browserAgent`, `spawnSubagent`, `MCPTool` (`mcp` alias), `manage_context`, `spawnAgent`, and `AgentMessage`. Awareness is driven through the bundled `octocode-awareness` CLI and skill hooks, not legacy memory tools.

---

## 5. Instructions / system prompt

Pi assembles the system prompt from (`usage.md` §Context Files / System Prompt Files):
- **Replace:** `.pi/SYSTEM.md` (project) or `~/.pi/agent/SYSTEM.md` (global), or `--system-prompt <text>`.
- **Append:** `APPEND_SYSTEM.md` (either location) or `--append-system-prompt <text>`.
- Context files: `AGENTS.md`/`CLAUDE.md` walking up from cwd + `~/.pi/agent/AGENTS.md`.
- Skills are injected as an `<available_skills>` block; context files + skills are appended **even when the prompt is replaced**.

Our core injects via the `before_agent_start` event, which on 0.80.x hands the extension
`event.systemPrompt` (chained) **and** `event.systemPromptOptions` with `.customPrompt`,
`.appendSystemPrompt`, `.contextFiles`, `.skills`, `.selectedTools`, `.toolSnippets`
(`extensions.md` §before_agent_start). Returning `{ systemPrompt }` replaces it for the turn.

- **append mode (default):** Pi prompt first, harness addendum after. Unchanged legacy behavior.
- **octocode-first mode (launcher):** harness leads as authority, Pi's prompt is preserved below.
  `replace` remains a legacy alias, but the behavior is intentionally prepend-not-drop.
  A true full replacement can be implemented later with the SDK `systemPromptOverride` /
  `systemPromptOptions` path if product branding needs it.

---

## 6. Tools

Built-ins: `read, bash, edit, write, grep, find, ls`; **default active** = `read, bash,
edit, write` (`sdk.md`/`usage.md`). Pruning options:
- CLI: `--tools/-t <allowlist>`, `--exclude-tools/-xt`, `--no-builtin-tools/-nbt`, `--no-tools`.
  Caveat: a `-t` allowlist must also list every custom/extension tool name to keep it enabled — brittle, so the launcher does **not** set `-t` by default.
- Extension: `pi.setActiveTools([...])` at `session_start` (RFC G2/Phase 3). This is the
  preferred lean-tools mechanism because it can keep our registered tools while dropping
  `grep`/`find`/`ls`.
- **Web access is not a Pi built-in** — the core registers a single `web` tool via
  `pi.registerTool` (RFC G3, **implemented**; `src/web.js`). `web({url})` fetches and reads
  a page as clean text; `web({query})` searches via a **provider ladder — Tavily → Serper →
  DuckDuckGo** (auto by which key is present; `engine` param forces one). Keys come from
  `~/.octocode/.env` / `<project>/.octocode/.env`, propagated into `process.env` at
  `session_start` by `src/env.js` (trust-gated, protected-key allowlist, values never
  logged). See RFC `.octocode/rfc/octocode-web-search`. SSRF-hardened:
  every resolved IP is checked against private/loopback/link-local/metadata/ULA/CGNAT ranges,
  redirects are re-validated per hop, with size + time caps. Residual DNS-rebinding race
  (public at check, private at connect) needs connection pinning — documented follow-up.

---

## 7. Packaging & the update path

Pi package rules (`packages.md`): resources declared under the `pi` key
(`extensions`, `skills`, `prompts`, `themes`) or by convention dirs. **Peer-dep rule:**
anything importing `@earendil-works/pi-*` or `typebox` must list them in
`peerDependencies: "*"` and not bundle them — the core imports `typebox` dynamically, so
it stays a peer. The octocode-agent launcher, by contrast, depends on
`@earendil-works/pi-coding-agent` as a real dependency because it *embeds/spawns* Pi (it
is a launcher, not a Pi package).

**Update path (the user's requirement — updating the core updates the agent):**
- `octocode-agent update` → self-update the platform globally (`npm i -g octocode-agent@latest`), which pins a newer core.
- `octocode-agent update core` → `npm install --prefix <launcher-root> --omit=dev @octocodeai/pi-extension@latest`.
  That updates the dependency inside the current launcher install, including npm/npx cache installs.
- Because the launcher loads the core via `-e <resolved local path>`, refreshing the
  dependency immediately changes what launches — no Pi-side reinstall needed.
- Pi's own `pi update [--all|--self|--extensions]` manages Pi + globally-installed
  packages; it does **not** touch our `-e`-loaded core, which is intentional (the platform
  owns the core version).

---

## 8. Open items / risks

- **Install freshness.** After changing dependency pins, run `yarn install` so `node_modules`
  matches `package.json`; launcher smoke tests verify real Pi/core package resolution without
  running an interactive Pi session.
- **Full SDK embed (§2)** remains designed-not-built. It is the path for deeper branding,
  direct session control, and a true `systemPromptOverride` if octocode-first prepend is not enough.

## Sources
`earendil-works/pi` `packages/coding-agent/docs/{usage,packages,sdk,extensions}.md` (branch `main`, npm `0.80.3`);
RFC `.octocode/rfc/octocode-pi-harness/{RFC,IMPLEMENTATION}.md`.
