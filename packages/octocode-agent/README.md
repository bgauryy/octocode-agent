# octocode-agent

<div align="center">
<strong>A self-working coding agent: the Pi runtime driven by the Octocode harness — one branded command, one update path.</strong>
</div>

---

## What this is

`octocode-agent` is the **user-facing Octocode agent platform**. It bundles two things and wires them together:

- **[Pi](https://github.com/earendil-works/pi)** — the coding-agent runtime (the shell, tool loop, providers). An internal detail.
- **[`@octocodeai/pi-extension`](../octocode-pi-extension)** — **the core harness**. The Octocode system prompt, research engine, tools, memory, Awareness Lite wiring, skills, themes, and launch-profile policy.

Install **`octocode-agent`** when you want the Octocode agent. It launches Pi with the core loaded in **octocode-first mode**, owns the branded command/update/auth/doctor/session UX, and keeps Pi runtime details underneath.

```bash
npm install -g octocode-agent
octocode-agent
```

Install `@octocodeai/pi-extension` directly only when you are already a Pi user and want to add the Octocode harness to your own Pi install (`pi install npm:@octocodeai/pi-extension`). That is an advanced/integration path, not the primary Octocode-agent install path.

### One tool palette

The launcher does not expose Pi's native `read`, `bash`, `edit`, `write`, `grep`, `find`, or
`ls` tools. Both the default SDK path and subprocess fallback suppress all Pi built-ins before
the session starts; there is no environment opt-out. The core supplies the full palette:

- local reads/search use Octocode research through `MCPTool`;
- `file` owns `edit`, `write`, and `delete` effects;
- the core registers its guarded same-name `bash` implementation;
- `readMedia` perceives local media, while `media` creates or transforms artifacts.

Direct extension installs also remove the replaced built-ins on load/session start as a
defensive backstop. See the core's [override contract](../octocode-pi-extension/docs/OVERRIDES.md).

## The core is the agent — one update path

`octocode-agent` has a real dependency on `@octocodeai/pi-extension`, so `npm install -g` and `npx` both get the pinned core automatically. Updating the core updates what the agent launches:

- **Automatically** — a platform release pins a newer core; `octocode-agent update` self-updates the platform and pulls it in.
- **By the user** — `octocode-agent update core` runs npm with this launcher install as `--prefix`, refreshing only `@octocodeai/pi-extension` in place. This works for global installs, local dev installs, and npm/npx cache installs.

Because the harness — prompt, skills, tools, memory, surface command specs, and launch-profile policy — all lives in the core package, none of it is duplicated here. This launcher stays thin on purpose: it imports core helpers directly from `@octocodeai/pi-extension` and only launches/updates/executes the returned specs. Users normally update through `octocode-agent`; direct Pi installs are managed by Pi's own extension/package commands and do not get the launcher UX.

## Usage

```bash
octocode-agent [agent args...] # Launch the agent; supported Pi-compatible args are mapped by the launcher
octocode-agent update         # Self-update the platform (pulls the newest core)
octocode-agent update core    # Update @octocodeai/pi-extension inside this install
octocode-agent --version      # Print launcher, core, and Pi host versions

octocode-agent auth [login]   # Credential status; `auth login` is a guided pick-provider wizard (writes ~/.octocode/.env, 0600)
octocode-agent models         # How to pick models; `models --set [id]` persists your default (interactive picker on a TTY)
octocode-agent resume         # Resume a session — picker over ALL projects' sessions; fuzzy `<id>` handled by Pi; `session` is an alias
octocode-agent doctor         # Health checks (core, Pi host, auth, awareness)
octocode-agent setup [--fix]  # First-run setup summary; --fix walks failing checks interactively
octocode-agent config         # Runtime/package/key view; add --json for scripting
                              #   `config get|set|list` reads/writes Pi's settings.json (writable keys: defaultProvider, defaultModel)
octocode-agent --smoke-test   # Install/CI self-check: launcher + core + Pi host must resolve
```

**Per-terminal `-c`:** in multiplexer terminals (tmux/zellij/kitty/wezterm/iTerm/WT) the launcher drops a breadcrumb per pane; a bare `-c`/`--continue` resumes THIS terminal's last session instead of the cwd-global newest (`~/.octocode/terminal-sessions/`).

**Environment:** `OCTOCODE_PI_*` vars mirror to `PI_*` for the launched session (e.g. `OCTOCODE_PI_CODING_AGENT_DIR` → `PI_CODING_AGENT_DIR`); an explicitly set `PI_*` always wins.

Any argument that isn't a reserved subcommand is handled by the SDK launcher when supported (`--print`, `--mode rpc`, `--continue`, `--session`, `--no-session`, `--name`, initial message) or passed to the subprocess fallback. A single bare token within edit distance of a real command gets `did you mean …` and exit 2 instead of a nonsense session.

**Exit codes:** `0` success · `1` runtime failure · `2` usage/unknown input (with suggestion) · `3` needs an interactive terminal.

## How it works

On launch the platform:

1. Imports Pi's SDK from its installed package and imports the bundled core factory (`createOctocodePiExtension`) from `@octocodeai/pi-extension`.
2. Sets the launch environment: `OCTOCODE_PROMPT_MODE=octocode-first` (harness leads; Pi prompt is preserved below), `OCTOCODE_AGENT=1`, and long Pi cache retention. It never overrides an `OCTOCODE_PROMPT_MODE` you set yourself.
3. Starts Pi in-process with `noTools: "builtin"` and `extensionFactories: [createOctocodePiExtension({ promptMode: 'octocode-first' })]`, so the Octocode core owns the tool palette without global Pi settings mutation.
4. Falls back to resolving the Pi executable and running `pi --no-builtin-tools --no-extensions -e <core>` when the SDK path is unavailable. The fallback loads the extension **and its packaged skills** for that run only — no global settings mutation, no trust prompt for our own package.

The core's default export stays append-mode and single-arg-callable, so the same package also works as a plain `pi install npm:@octocodeai/pi-extension`. Octocode-first mode is selected purely by the launcher/core contract — no divergent harness code path.

**Tunables (env):**
- `OCTOCODE_AGENT_EXTENSION_SPEC` — override the core spec Pi loads (`npm:…`, `git:…`, or a path). Default: the bundled package.
- `OCTOCODE_AGENT_CLEAN=1` — also pass `--no-skills --no-context-files`, so only the Octocode harness package loads (deterministic branded agent).
- `OCTOCODE_AGENT_NO_CONTEXT_FILES=1` — suppress project context files; by default they stay enabled so repository rules remain authoritative.

See [`docs/PI_INTEGRATION.md`](docs/PI_INTEGRATION.md) for how Pi works, the launch/UX/commands/instructions model, and the SDK-embed evolution path.

## Links

[Octocode](https://octocode.ai) · [The core (`@octocodeai/pi-extension`)](../octocode-pi-extension) · [Pi](https://github.com/earendil-works/pi) · [RFC](../../.octocode/rfc/octocode-pi-harness/RFC.md)
