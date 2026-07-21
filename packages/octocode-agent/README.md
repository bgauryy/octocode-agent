# octocode-agent

<div align="center">
<strong>A self-working coding agent: the Pi runtime driven by the Octocode harness — one branded command, one update path.</strong>
</div>

---

## What this is

`octocode-agent` is the **platform**. It bundles two things and wires them together:

- **[Pi](https://github.com/earendil-works/pi)** — the coding-agent runtime (the shell, tool loop, providers). An internal detail.
- **[`@octocodeai/pi-extension`](../octocode-pi-extension)** — **the core**. The Octocode harness: the authored system prompt, the research engine, persistent memory, the awareness file-lock bridge, and the research skills.

The agent is the core. `octocode-agent` just launches Pi with that core loaded in **octocode-first mode** so the Octocode harness leads while Pi's runtime invariants remain underneath.

```bash
npm install -g octocode-agent
octocode-agent
```

## The core is the agent — one update path

`octocode-agent` has a real dependency on `@octocodeai/pi-extension`, so `npm install -g` and `npx` both get the pinned core automatically. Updating the core updates what the agent launches:

- **Automatically** — a platform release pins a newer core; `octocode-agent update` self-updates the platform and pulls it in.
- **By the user** — `octocode-agent update core` runs npm with this launcher install as `--prefix`, refreshing only `@octocodeai/pi-extension` in place. This works for global installs, local dev installs, and npm/npx cache installs.

Because the harness — prompt, skills, tools, memory — all lives in the core package, none of it is duplicated here. This launcher stays thin on purpose.

## Usage

```bash
octocode-agent [agent args...] # Launch the agent; supported Pi-compatible args are mapped by the launcher
octocode-agent update         # Self-update the platform (pulls the newest core)
octocode-agent update core    # Update @octocodeai/pi-extension inside this install
octocode-agent --version      # Print launcher, core, and Pi host versions
octocode-agent --agent-help   # Launcher help (reserved subcommands only)
```

Any argument that isn't a reserved subcommand (`update`, `--version`, `--agent-help`) is handled by the SDK launcher when supported (`--print`, `--mode rpc`, `--continue`, `--session`, `--no-session`, `--name`, initial message) or passed to the subprocess fallback.

## How it works

On launch the platform:

1. Imports Pi's SDK from its installed package and imports the bundled core factory (`createOctocodePiExtension`) from `@octocodeai/pi-extension`.
2. Sets the launch environment: `OCTOCODE_PROMPT_MODE=octocode-first` (harness leads; Pi prompt is preserved below), `OCTOCODE_AGENT=1`, and long Pi cache retention. It never overrides an `OCTOCODE_PROMPT_MODE` you set yourself.
3. Starts Pi in-process with `extensionFactories: [createOctocodePiExtension({ promptMode: 'octocode-first' })]`, so the Octocode core loads without global Pi settings mutation.
4. Falls back to resolving the Pi executable and running `pi --no-extensions -e <core>` when the SDK path is unavailable. The fallback loads the extension **and its packaged skills** for that run only — no global settings mutation, no trust prompt for our own package.

The core's default export stays append-mode and single-arg-callable, so the same package also works as a plain `pi install npm:@octocodeai/pi-extension`. Octocode-first mode is selected purely by the launcher/core contract — no divergent harness code path. The legacy value `OCTOCODE_PROMPT_MODE=replace` remains accepted as an alias.

**Tunables (env):**
- `OCTOCODE_AGENT_EXTENSION_SPEC` — override the core spec Pi loads (`npm:…`, `git:…`, or a path). Default: the bundled package.
- `OCTOCODE_AGENT_CLEAN=1` — also pass `--no-skills --no-context-files`, so only the Octocode harness package loads (deterministic branded agent).
- `OCTOCODE_AGENT_NO_CONTEXT_FILES=1` — suppress `AGENTS.md` / `CLAUDE.md`; by default project context files stay enabled so repository rules remain authoritative.

See [`docs/PI_INTEGRATION.md`](docs/PI_INTEGRATION.md) for how Pi works, the launch/UX/commands/instructions model, and the SDK-embed evolution path.

## Links

[Octocode](https://octocode.ai) · [The core (`@octocodeai/pi-extension`)](../octocode-pi-extension) · [Pi](https://github.com/earendil-works/pi) · [RFC](../../.octocode/rfc/octocode-pi-harness/RFC.md)
