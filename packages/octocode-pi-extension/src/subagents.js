/**
 * Subagent registry — typed configuration for every specialised Pi subagent
 * this extension ships.
 *
 * Each subagent has:
 *   - A typed name (union literal)
 *   - Tool allowlist (no nested spawning; write tools stay out unless a role explicitly needs them)
 *   - Resource mode (always 'octocode' so the extension's own tools are available)
 *   - SYSTEM_PROMPT.md path loaded at runtime from dist/subagents/<name>/
 *   - All bundled Octocode skills, plus any subagent-local skill dirs
 *
 * The spawnSubagent tool reads this registry, loads the system prompt,
 * and calls spawnRpcAgent (same internal fn as spawnAgent, same agents Map →
 * AgentMessage works on anything spawned here).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// ─── Runtime path resolution ──────────────────────────────────────────────────
function resolveSubagentsDir() {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const distDir = path.join(moduleDir, 'subagents');
    if (fs.existsSync(distDir))
        return distDir;
    return path.resolve(moduleDir, '..', 'subagents');
}
/** dist/subagents/ in published builds; packageRoot/subagents/ in source tests. */
const SUBAGENTS_DIR = resolveSubagentsDir();
function resolveSkillsDir() {
    const siblingSkillsDir = path.join(path.dirname(SUBAGENTS_DIR), 'skills');
    if (fs.existsSync(siblingSkillsDir))
        return siblingSkillsDir;
    return path.resolve(path.dirname(SUBAGENTS_DIR), '..', '..', 'skills');
}
const SKILLS_DIR = resolveSkillsDir();
/**
 * Returns external skill search roots, re-evaluated on every call so skills
 * installed after process start are discovered without a restart.
 *
 * `npx octocode skill --name <skill> --platform pi` lands in ~/.pi/agent/skills/;
 * monorepo / standalone workspaces often stage skills at <cwd>/.agents/skills/ via
 * `octocode skill --add --path`. No existsSync filter here — bundledSkillPath checks
 * for SKILL.md presence in each root, so absent dirs are handled gracefully.
 *
 * Exported for testing dynamic cwd behaviour.
 */
export function getExternalSkillDirs() {
    const dirs = [];
    const home = process.env.HOME;
    if (home)
        dirs.push(path.join(home, '.pi', 'agent', 'skills'));
    const cwdAgentsSkills = path.resolve(process.cwd(), '.agents', 'skills');
    if (!dirs.includes(cwdAgentsSkills))
        dirs.push(cwdAgentsSkills);
    return dirs;
}
export const OCTOCODE_SKILL_NAMES = [
    'octocode-awareness',
    'octocode-brainstorming',
    'octocode-prompt-optimizer',
    'octocode-research',
    'octocode-rfc-generator',
    'octocode-roast',
    'octocode-skills',
    'octocode-subagent',
];
function subagentSkillPath(name, skillName) {
    return path.join(SUBAGENTS_DIR, name, 'skills', skillName);
}
function bundledSkillPath(skillName) {
    // Preferred: a skill staged in the package's dist/skills/ (what build.mjs composes).
    // Fallbacks: skills installed outside the package — `npx octocode skill --name <skill>
    // --platform pi` lands in ~/.pi/agent/skills/, and monorepo layouts often stage skills
    // at <cwd>/.agents/skills/ via `octocode skill --add --path ...`. Surfacing them lets
    // typed subagents load skills the package itself doesn't ship (this extension ships
    // only octocode-awareness); a manual install (`npx octocode skill ... --platform pi`)
    // is required for the rest. First hit wins — the bundled copy wins over an external install
    // when both exist, keeping tests deterministic.
    for (const root of [SKILLS_DIR, ...getExternalSkillDirs()]) {
        if (fs.existsSync(path.join(root, skillName, 'SKILL.md'))) {
            return path.join(root, skillName);
        }
    }
    return null;
}
function allOctocodeSkillPaths(...extraSkillPaths) {
    // Only pass skills whose SKILL.md is present in the bundled dir OR any external
    // install root (see bundledSkillPath). Filter removes nulls so bundled-and-installed
    // resolves to one list with no duplicates (each root is searched in fixed order;
    // first hit wins, so the bundled copy wins over an external install when both exist).
    const shipped = OCTOCODE_SKILL_NAMES
        .map(skillName => bundledSkillPath(skillName))
        .filter((dir) => dir !== null);
    // Apply the same existence guard to caller/subagent-supplied skill paths, so a partial
    // build (e.g. browser-agent skill dir not yet copied) does not pass a nonexistent --skill
    // path to pi (which warns per path). Consistent with the named-skill filter above.
    const extraShipped = extraSkillPaths.filter(skillPath => fs.existsSync(path.join(skillPath, 'SKILL.md')));
    return [
        ...shipped,
        ...extraShipped,
    ];
}
/**
 * Resolves the full skill list for a subagent at CALL TIME (not at import time).
 *
 * - If config.skills is set explicitly, returns it as-is (override path).
 * - Otherwise computes allOctocodeSkillPaths(extraSkillPaths) on every call,
 *   so late-installed skills (added after process start) are discovered without restart.
 */
export function resolveSubagentSkills(config) {
    if (config.skills !== undefined)
        return config.skills;
    return allOctocodeSkillPaths(...(config.extraSkillPaths ?? []));
}
function subagentPromptPath(name) {
    return path.join(SUBAGENTS_DIR, name, 'SYSTEM_PROMPT.md');
}
export function loadSystemPrompt(config) {
    const p = config.systemPromptPath;
    if (!fs.existsSync(p)) {
        throw new Error(`subagent system prompt not found: ${p}\n` +
            `Run: yarn workspace @octocodeai/pi-extension build`);
    }
    return fs.readFileSync(p, 'utf8');
}
// ─── Registry ─────────────────────────────────────────────────────────────────
export const SUBAGENT_REGISTRY = {
    'browser-agent': {
        name: 'browser-agent',
        label: 'Browser Agent',
        description: 'Specialised browser debugging subagent. Has chromeDebug + web + local search tools. ' +
            'Use for multi-turn Chrome DevTools Protocol work: security audits, network analysis, ' +
            'DOM inspection, coverage, workers, service workers, emulation, and automation.',
        tools: [
            'chromeDebug', // CDP execution — primary tool
            'web', // CDP docs + web research
            'localGetFileContent', // read source files, screenshots
            'localSearchCode', // correlate browser errors to local source
            'localViewStructure', // navigate file trees
        ],
        resourceMode: 'octocode',
        thinking: 'low',
        systemPromptPath: subagentPromptPath('browser-agent'),
        extraSkillPaths: [subagentSkillPath('browser-agent', 'browser-agent')],
    },
    researcher: {
        name: 'researcher',
        label: 'Researcher',
        description: 'Fast Octocode research specialist. Has web, GitHub, npm, local, binary, and LSP tools. ' +
            'Use for evidence gathering, prior art, package/repo lookup, and concise claim ledgers.',
        tools: [
            'web',
            'ghSearchCode',
            'ghGetFileContent',
            'ghViewRepoStructure',
            'ghSearchRepos',
            'ghHistoryResearch',
            'ghCloneRepo',
            'npmSearch',
            'localSearchCode',
            'localViewStructure',
            'localFindFiles',
            'localGetFileContent',
            'localBinaryInspect',
            'lspGetSemantics',
        ],
        resourceMode: 'octocode',
        thinking: 'low',
        systemPromptPath: subagentPromptPath('researcher'),
    },
    planner: {
        name: 'planner',
        label: 'Planner',
        description: 'Implementation planning specialist. Has all Octocode research surfaces and all bundled skills. ' +
            'Use for dependency-ordered plans, risks, verification strategy, and RFC handoff packets.',
        tools: [
            'web',
            'ghSearchCode',
            'ghGetFileContent',
            'ghViewRepoStructure',
            'ghSearchRepos',
            'ghHistoryResearch',
            'ghCloneRepo',
            'npmSearch',
            'localSearchCode',
            'localViewStructure',
            'localFindFiles',
            'localGetFileContent',
            'localBinaryInspect',
            'lspGetSemantics',
        ],
        resourceMode: 'octocode',
        thinking: 'low',
        systemPromptPath: subagentPromptPath('planner'),
    },
    architect: {
        name: 'architect',
        label: 'Architect',
        description: 'Root-cause and local-code architecture specialist. Has all Octocode skills, local/LSP/binary tools, ' +
            'GitHub history, web, and bash for targeted debug/test loops.',
        tools: [
            'bash',
            'web',
            'ghSearchCode',
            'ghGetFileContent',
            'ghViewRepoStructure',
            'ghSearchRepos',
            'ghHistoryResearch',
            'ghCloneRepo',
            'npmSearch',
            'localSearchCode',
            'localViewStructure',
            'localFindFiles',
            'localGetFileContent',
            'localBinaryInspect',
            'lspGetSemantics',
        ],
        resourceMode: 'octocode',
        thinking: 'medium',
        systemPromptPath: subagentPromptPath('architect'),
    },
};
export const SUBAGENT_NAMES = Object.keys(SUBAGENT_REGISTRY);
