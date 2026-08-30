# Monitoring and provider metrics

The native runtime exposes a versioned, read-only `monitoring.snapshot` command through
the runtime and JSON-RPC command path. This is the safe metrics surface. JSONL transports
redact prompt and tool payloads by default. A trusted embedded consumer must explicitly
request full event exposure; treat that full lifecycle stream as debug data and don't
export it as telemetry.

## Snapshot contract

`MonitoringSnapshotV1` reports only bounded scalar and enumerated data:

- current model identity and normalized token totals;
- provider request, response, failure, retry, and cancellation counts;
- aggregate request duration and time to first model delta;
- failure counts grouped by the runtime's bounded error category.
- Octocode catalog cache hits, misses, loads, load failures, expirations,
  evictions, current size, capacity, and TTL.

Missing cache usage stays absent. It is never converted to zero. The snapshot doesn't
contain prompts, messages, tool payloads, provider response bodies, endpoints, headers,
credential references, or arbitrary exception messages.

Each provider attempt has a deterministic `requestId` shared by its request, message,
failure, and response events. Terminal provider events also contain the attempt number,
maximum attempts, duration, and—when a delta arrived—time to first delta. This makes the
debug stream correlatable without putting content into the monitoring snapshot.

```json
{"protocolVersion":1,"requestId":"metrics-1","command":{"type":"monitoring.snapshot"}}
```

## Cache and cost semantics

Provider usage is normalized before aggregation. In particular, Anthropic's uncached,
cache-read, and cache-creation input counters are summed into total `inputTokens`, while
the cache counters remain separately available. Custom compatible providers use the
same normalized contract; omitted vendor fields remain unavailable.

Model discovery accepts `promptCaching.mode` values `auto`, `enabled`, and `disabled`,
plus optional `cacheRead` and `cacheWrite` per-million prices. Discovery records those
capabilities but doesn't claim a protocol supports cache controls it can't execute.
Cost estimates must remain unavailable until all applicable prices and token semantics
are known.

The live Octocode tool catalog uses a 60-second, 32-entry least-recently-used process
cache. Expired and rejected loads are removed, and in-flight loads remain deduplicated.
Its counters are included under `monitoring.snapshot.native.cache`; cache keys and
catalog contents are not included. The runtime rejects negative, unsafe, or internally
inconsistent counter snapshots.

## Provider boundary

Native Octocode doesn't import Pi's provider runtime. OpenAI Chat Completions, OpenAI
Responses, and Anthropic Messages are executable native protocols. Other vendors are
executable only when their endpoint is genuinely compatible with one of those protocols.
Google Generative AI and Bedrock remain discovery-only until Octocode-owned adapters can
preserve their provider continuation metadata through tool calls, sessions, resume, and
compaction.
