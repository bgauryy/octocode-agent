# @octocodeai/pi-extension docs

Docs in this directory belong to the Pi harness extension.
Keep harness runtime, bundled tools, Awareness wiring, prompt/override behavior,
and Pi UI notes here. Exact tool field schemas remain generated/runtime-owned:
use `node $OCTOCODE_CLI tools <name> --scheme`.

## Index

### Core references

| Document | Owns |
|---|---|
| [TOOLS.md](TOOLS.md) | Complete tool inventory, routing rules, CLI schema lookup, and Awareness-as-CLI guidance. |
| [OVERRIDES.md](OVERRIDES.md) | Branded-launcher native-tool suppression, direct-extension backstop, and replacement routes. |
| [WHY_OCTOCODE.md](WHY_OCTOCODE.md) | Product positioning, capability profiles, and comparison with vanilla Pi. |

### Media & FFmpeg

| Document | Owns |
|---|---|
| [FFMPEG.md](FFMPEG.md) | Complete ffmpeg guide: discovery, exact argvs, `runFfmpeg` reference, routing, anti-patterns, 16 cookbook recipes, hardware encoding, screen capture, bundling, and capability matrix. |
| [MEDIA_TOOL.md](MEDIA_TOOL.md) | RFC and routing contract for `readMedia` vs `media` (two-tool effect boundary). |

### Agent coordination & subagents

| Document | Owns |
|---|---|
| [AWARENESS_AGENT_FLOW.md](AWARENESS_AGENT_FLOW.md) | Agent lifecycle for using Awareness Lite inside Pi sessions. |
| [AGENT_ORCHESTRATOR.md](AGENT_ORCHESTRATOR.md) | Pi SDK subagent orchestration contract, rollback notes, and UX policy. |
| [SUBAGENTS.md](SUBAGENTS.md) | Spawn profiles, live control, durable peer communication, and isolation. |
| [REFLECT.md](REFLECT.md) | Reflection and memory workflow as exposed through the harness. |

### Runtime & TUI

| Document | Owns |
|---|---|
| [UI.md](UI.md) | TUI design contract, widget inventory, responsive layout, core flows, and troubleshooting. |
| [SETTINGS.md](SETTINGS.md) | Complete `/settings` control-center reference: commands, MCP, discovery, tools, skills, persistence, security, refresh behavior, and limitations. |
| [RUNTIME_STATE.md](RUNTIME_STATE.md) | Session initialization, Zustand state ownership, MCP readiness, and disposal. |
| [SESSION_ARTIFACTS.md](SESSION_ARTIFACTS.md) | Where session files live (plans, screenshots, logs, compaction snapshots), manifest, and cleanup. |
| [CRON.md](CRON.md) | Session job safety model, default jobs, and cron-style maintenance commands. |
| [SHELL.md](SHELL.md) | OctocodeShell RFC — TUI shell replacing Pi’s InteractiveMode (Phase C alpha). |

### Audit & decisions

| Document | Owns |
|---|---|
| [AGENT_TOOL_AUDIT.md](AGENT_TOOL_AUDIT.md) | Tool-surface audit: direct palette ratings, Awareness signal value, follow-up priorities. |

---

Harness-wide capability discovery (MCP catalog, `skill` tool, `.octocode/discovery.json`,
context composition) is documented at repo root:
[`docs/DISCOVERY.md`](../../../docs/DISCOVERY.md).

Do not add package command catalogs here. Package scripts are manifest-owned;
user-facing launcher commands belong in
`packages/octocode-agent/docs/PI_INTEGRATION.md` or launcher help.
