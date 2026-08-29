# Sources

Load when auditing the origin of the skill's orchestration contract. Why: this appendix identifies the local instruction sources consulted without making the standalone skill depend on their files.

- OpenAI `skill-creator`: progressive disclosure, implicit invocation metadata, standalone validation, and independent forward testing.
- Octocode `octocode-skills`: lobby/reference ownership, trigger tuning, cleanup, and zero-error review gate.
- Octocode `octocode-subagent`: spawn economics, dependency-aware decomposition, sealed packets, write ownership, barrier, and parent synthesis.
- Octocode `octocode-graph-eval`: goal-to-KPI contracts, red→green agent TDD, held-out checks, guardrails, graph-boundary metrics, and fresh-context verification.
- Octocode `octocode-awareness`: conditional shared-state inspection, bounded work declarations, locks, verification receipts, closing, and reflection.
- [OpenAI Agents SDK orchestration](https://openai.github.io/openai-agents-python/multi_agent/): manager versus handoff, deterministic orchestration, and independent parallelism.
- [OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/): filtered handoff context and authorization before side effects.
- [Anthropic multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system): bounded delegation packets, effort scaling, observability, and outcome evaluation.
- [Anthropic multiagent systems research](https://www.anthropic.com/research/multiagent-systems): correlated consensus and conflicting-goal risks.
- [Agent Skills specification](https://agentskills.io/specification): progressive disclosure and focused one-level references.

Consulted 2026-08-28. These are design sources, not runtime dependencies. When installed, `octocode-subagent` owns spawn mechanics, `octocode-graph-eval` owns strategy-eval verdicts, and Awareness owns shared state; this skill's references are compact standalone fallbacks.

This audit-trail step ends here.
