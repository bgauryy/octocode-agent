/**
 * spawnSubagent — typed subagent spawning.
 *
 * Unlike the generic spawnAgent, this tool:
 *   - Has a closed enum of registered subagent types (type-safe, discoverable)
 *   - Pre-loads the subagent's SYSTEM_PROMPT.md from dist/subagents/<name>/
 *   - Enforces the correct tool allowlist and resource mode per subagent
 *   - Loads every bundled Octocode skill for Octocode specialist subagents
 *   - Passes subagent-specific params (url, port) as structured context in the task
 *   - Returns agentId for AgentMessage (same agents Map as spawnAgent)
 *
 * Main agent workflow:
 *   1. spawnSubagent({agent:"browser-agent", task:"audit cookies on example.com", url:"https://example.com"})
 *      → { agentId: "abc123", usage: "AgentMessage({action:\"wait\", agentId:\"abc123\"})" }
 *   2. AgentMessage({action:"wait", agentId:"abc123", timeoutMs:60000})
 *   3. AgentMessage({action:"send", agentId:"abc123", message:"now check service workers"})
 *   4. AgentMessage({action:"kill", agentId:"abc123", remove:true})
 */
import { makeRenderer, truncateToWidth } from './render-helpers.js';
import { spawnRpcAgent, isSubagentProcess, } from './agent-tools.js';
import { SUBAGENT_REGISTRY, SUBAGENT_NAMES, loadSystemPrompt, resolveSubagentSkills, } from '../subagents.js';
import { getRandomAgentName } from '../agentNames.js';
const CHROME_DISABLED_ENV = 'OCTOCODE_CHROME_DEBUG';
function buildTaskWithContext(params) {
    const agent = params.agent;
    const lines = [];
    // Browser-agent: inject session params at top so the subagent has them from turn 1
    if (agent === 'browser-agent') {
        lines.push('## Browser Session');
        if (params.url)
            lines.push(`Target URL: ${params.url}`);
        lines.push(`Chrome port: ${params.port ?? 9222}`);
        if (params.launch)
            lines.push(`Launch Chrome: true (start Chrome if not running)`);
        if (params.headless === false)
            lines.push(`Headless: false (visible Chrome)`);
        lines.push('');
    }
    if (params.context) {
        lines.push('## Context');
        lines.push(params.context.trim());
        lines.push('');
    }
    lines.push('## Task');
    lines.push(params.task.trim());
    return lines.join('\n');
}
function buildAgentName(params) {
    if (params.name)
        return params.name;
    const config = SUBAGENT_REGISTRY[params.agent];
    const codename = getRandomAgentName();
    let slug = '';
    if (params.url) {
        try {
            slug = ` · ${new URL(params.url).hostname.replace(/^www\./, '')}`;
        }
        catch {
            // ignore
        }
    }
    return `${config.label} · ${codename}${slug}`;
}
function isChromeDebugEnabled() {
    return process.env[CHROME_DISABLED_ENV] !== '0';
}
function getAvailableSubagentNames() {
    if (isChromeDebugEnabled())
        return [...SUBAGENT_NAMES];
    return SUBAGENT_NAMES.filter((name) => name !== 'browser-agent');
}
function unavailableSubagentMessage(agent, availableNames) {
    if (agent === 'browser-agent' && !isChromeDebugEnabled()) {
        return `browser-agent is unavailable because ${CHROME_DISABLED_ENV}=0 disables chromeDebug. Available: ${availableNames.join(', ')}`;
    }
    return `Unknown subagent: "${agent}". Available: ${availableNames.join(', ')}`;
}
// ─── Registration ─────────────────────────────────────────────────────────────
export function registerSpawnSubagentTool(pi, Type, registeredToolNames, registerFn, _notify) {
    // Workers cannot spawn workers — never register this tool inside a spawned worker process.
    if (isSubagentProcess())
        return;
    const availableSubagentNames = getAvailableSubagentNames();
    const availableSubagentSet = new Set(availableSubagentNames);
    const availableSubagents = availableSubagentNames.map((name) => {
        const config = SUBAGENT_REGISTRY[name];
        return `  ${name} — ${config.description} Tools: ${config.tools.join(', ')}.`;
    }).join('\n');
    const skillGuideline = isChromeDebugEnabled()
        ? 'Every typed subagent loads any Octocode skills already installed; browser-agent also loads its browser-agent skill.'
        : 'Every available typed subagent loads any Octocode skills already installed; browser-agent is unavailable while Chrome debug is disabled.';
    registerFn(pi, registeredToolNames, {
        name: 'spawnSubagent',
        label: 'Spawn Subagent',
        description: [
            'Spawn a typed, pre-configured Pi subagent with the right tools, system prompt, resource mode, and all bundled Octocode skills.',
            'Use spawnAgent instead when you need a clean arbitrary worker with only the tools/skills you explicitly provide.',
            'Returns an agentId — use AgentMessage to coordinate (wait, send, steer, status, kill).',
            '',
            'Available subagents:',
            availableSubagents,
            '',
            'After spawning:',
            '  AgentMessage({action:"wait",   agentId, timeoutMs:60000})      — wait for the current turn',
            '  AgentMessage({action:"status", agentId})                       — poll without blocking',
            '  AgentMessage({action:"send",   agentId, message:"next task"})  — send follow-up',
            '  AgentMessage({action:"steer",  agentId, message:"new focus"})  — redirect before the next model step',
            '  AgentMessage({action:"kill",   agentId, remove:true})          — terminate when done',
        ].join('\n'),
        promptSnippet: 'Spawn a typed Octocode specialist subagent with pre-configured tools, system prompt, and all Octocode skills',
        promptGuidelines: [
            `Use spawnSubagent for typed Octocode specialists: ${availableSubagentNames.join(', ')}.`,
            skillGuideline,
            'Use spawnAgent for clean arbitrary workers. spawnAgent defaults to lean/no-skills and only uses tools/skills you pass.',
            'Use `pi -ne --list-models [search]` as the source of truth for the user-configured model table; do not read hardcoded config paths.',
            'Pass model for each typed subagent: fastest capable configured model for small tasks, balanced coding/reasoning model for medium tasks, strongest configured model for large/high-risk work.',
            'Use AgentMessage(wait) to collect the current turn; treat [DONE] as phase completion and check the delegated acceptance criteria before declaring the objective complete.',
            'Typed subagents emit structured prefixed lines such as [FINDING], [EVIDENCE], [ACTION], [PLAN], [BLOCKED], and [DONE] — parse these for synthesis.',
            'Kill the agent with AgentMessage(kill, remove:true) when done to free resources.',
        ],
        parameters: Type.Object({
            agent: Type.Unsafe({
                type: 'string',
                enum: availableSubagentNames,
                description: `Subagent type to spawn. Available: ${availableSubagentNames.join(', ')}.`,
            }),
            task: Type.String({
                description: 'What the subagent should do. Be specific: include URLs, what to look for, what to emit. ' +
                    'The subagent stays alive — you can send follow-ups via AgentMessage.',
            }),
            context: Type.Optional(Type.String({ description: 'Additional context prepended to the task (background info, prior findings).' })),
            name: Type.Optional(Type.String({ description: 'Human label for AgentMessage list output. Auto-generated if omitted.' })),
            cwd: Type.Optional(Type.String({ description: 'Working directory for the subagent process. Defaults to current cwd.' })),
            model: Type.Optional(Type.String({ description: 'Model override from `pi -ne --list-models [search]`. Defaults to subagent default. Choose from the live user-configured table; `--models` only sets model-cycling scope.' })),
            provider: Type.Optional(Type.String({ description: 'Pi provider name for the model. REQUIRED when the model id collides with a builtin provider namespace (e.g. a custom provider offering `claude-*`); without it pi may resolve to the builtin provider and fail with "No API key found". Look up via `pi -ne --list-models [search]`.' })),
            thinking: Type.Optional(Type.String({ description: 'Thinking level: off|minimal|low|medium|high|xhigh. Defaults to subagent default.' })),
            // browser-agent specific params (ignored by other subagents)
            url: Type.Optional(Type.String({ description: '(browser-agent) Target URL. Injected into task context.' })),
            port: Type.Optional(Type.Integer({ description: '(browser-agent) Chrome remote debug port. Default 9222.' })),
            launch: Type.Optional(Type.Boolean({ description: '(browser-agent) Launch Chrome if not running. Default false.' })),
            headless: Type.Optional(Type.Boolean({ description: '(browser-agent) Headless Chrome. Default true.' })),
        }),
        async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
            const params = rawParams;
            const config = SUBAGENT_REGISTRY[params.agent];
            if (!config || !availableSubagentSet.has(params.agent)) {
                throw new Error(unavailableSubagentMessage(String(params.agent ?? ''), availableSubagentNames));
            }
            // Load system prompt from dist/subagents/<name>/SYSTEM_PROMPT.md
            const systemPrompt = loadSystemPrompt(config);
            // Build spawn params
            const spawnParams = {
                task: buildTaskWithContext(params),
                name: buildAgentName(params),
                cwd: params.cwd,
                tools: [...config.tools],
                skills: resolveSubagentSkills(config),
                resourceMode: config.resourceMode,
                systemPrompt,
                thinking: params.thinking ?? config.thinking,
                model: params.model ?? config.model,
                provider: params.provider ?? config.provider,
                noSession: true,
            };
            // Spawn via the same internal function as spawnAgent → same agents Map → AgentMessage works
            const record = spawnRpcAgent(spawnParams, ctx);
            const agentId = record.id;
            const usage = [
                `AgentMessage({action:"wait",   agentId:"${agentId}", timeoutMs:60000})`,
                `AgentMessage({action:"send",   agentId:"${agentId}", message:"<follow-up>"})`,
                `AgentMessage({action:"status", agentId:"${agentId}"})`,
                `AgentMessage({action:"kill",   agentId:"${agentId}", remove:true})`,
            ].join('\n');
            const output = [
                `[SPAWNED] ${config.label} · agentId: ${agentId}`,
                `[SPAWNED] name: ${record.name}`,
                `[SPAWNED] tools: ${config.tools.join(', ')}`,
                `[SPAWNED] skills: ${resolveSubagentSkills(config).map((skillPath) => skillPath.split(/[\/]/).at(-1)).join(', ')}`,
                `[SPAWNED] resourceMode: ${config.resourceMode}`,
                `[SPAWNED] task: ${params.task.slice(0, 120)}${params.task.length > 120 ? '…' : ''}`,
                '',
                '[USAGE]',
                usage,
            ].join('\n');
            return {
                content: [{ type: 'text', text: output }],
                agentId,
            };
        },
        renderCall(rawParams) {
            const p = rawParams;
            const config = SUBAGENT_REGISTRY[p.agent];
            const label = config?.label ?? p.agent;
            const url = p.url ? ` → ${p.url}` : '';
            const raw = `spawnSubagent(${label}${url}) "${p.task.slice(0, 45)}${p.task.length > 45 ? '…' : ''}"`;
            return makeRenderer((w) => [truncateToWidth(raw, w)]);
        },
        renderResult(result, _opts, theme) {
            const r = result;
            const text = r?.content?.[0]?.text ?? '';
            const agentLine = text.split('\n').find((l) => l.startsWith('[SPAWNED]')) ?? '';
            const raw = (theme?.fg('success', agentLine) ?? agentLine) || 'spawnSubagent: spawned';
            return makeRenderer((w) => [truncateToWidth(raw, w)]);
        },
    });
}
