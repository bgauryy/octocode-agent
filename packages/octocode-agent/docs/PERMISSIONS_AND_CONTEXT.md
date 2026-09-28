# Permissions and context

The native agent keeps permission policy and context policy in the host-neutral core.
The launcher selects modes and supplies adapters; transports and renderers only collect
or display decisions.

## Permission modes

Run a one-shot agent with an explicit mode:

```bash
octocode-agent run --permissions strict "Review this repository"
octocode-agent run --permissions default "Fix the failing test"
octocode-agent run --permissions allow-all "Apply the approved local refactor"
```

| Mode | Promptable approval | Mandatory approval | Other guards |
|---|---|---|---|
| `strict` | Ask; deny when no reviewer exists | Ask; deny when no reviewer exists | Always enforced |
| `default` | Follow the tool declaration | Ask; deny when no reviewer exists | Always enforced |
| `allow-all` | Skip only in a trusted workspace | Ask; deny when no reviewer exists | Always enforced |

Other guards include schema validation, workspace and managed trust, plan state, lock
ownership, the registered capability ceiling, cancellation, bounded concurrency, and
effect admission. `allow-all` is not a sandbox escape. The permission decision is
versioned and is bound into the effect receipt before execution.

Input-sensitive policy may narrow a registered tool's effects. It cannot add an effect
outside the static capability ceiling. This lets reviewed custom tools use declared
capabilities without relying on their names and prevents a resolver from escalating a
read-only registration into write, network, process, or destructive work.

## Context artifacts

Core represents reusable context as strict version-one artifacts. An artifact records:

- kind, authority, trust, scope, visibility, and rehydration behavior;
- source identifiers and revision, freshness, retention, and superseded identities;
- inline content or a reference, never both, plus its SHA-256 digest;
- a whole-artifact token budget and `stable`, `epoch`, `dynamic`, or `never-cache`
  placement.

Assembly validates every artifact, resolves references, removes duplicate and
superseded entries, and orders cache strata deterministically. Stable and epoch blocks
are placed before dynamic plans, skills, memory leads, semantic evidence, and tool
results. Rejected material receives a bounded drop receipt. Generated summaries and
memory are escaped inside an explicit data-only envelope, so their contents never gain
system-instruction authority.

The stable-prefix digest covers only stable and epoch blocks. Changing a plan, memory
lead, skill result, or tool result therefore does not silently change the measured
cacheable prefix. Provider cache-read and cache-write token counters remain the source
of truth for whether a provider actually reused that prefix.

This assembler is currently an exported core boundary. Native still uses its existing
stable prompt and durable compaction composition while plan, skill, memory, and tool
result producers migrate to artifacts. Do not claim artifact drop receipts or stable
prefix identity for a host path until that host actually composes the assembler.

## Compaction and session documents

Compaction prepares and validates a summary projection, commits it to the durable
session record, and only then changes live model context. Resume reconstructs the
committed summary and retained events; a failed or cancelled compaction leaves the
previous usable context intact.

A user can also ask the running agent to summarize the session, plan, or feature into a
workspace document. This is an ordinary `file` write: the model proposes the document,
the normal permission/effect pipeline applies, and the Rust filesystem service performs
the bounded atomic replacement after approval. It does not mutate the hidden compaction
record, and compaction never writes an arbitrary workspace document by itself.

Skills use the same separation. Skill instructions are reviewed and read through the
contained `skill` facade; their metadata does not grant tools. Rust may store opaque
records but never decides their semantic authority.
