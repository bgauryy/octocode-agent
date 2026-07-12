/**
 * Registration of the 13 native Octocode direct tools.
 *
 * The tool schema + description are loaded from @octocodeai/octocode-tools-core/schema
 * (engine-free). Execution loads /direct + /config lazily so the native addon is
 * never required during extension boot or schema inspection.
 */
import { formatDirectToolSchemaText, getDirectToolCategory as getCoreDirectToolCategory, getDirectToolDescription as getCoreDirectToolDescription, loadToolContent, } from '@octocodeai/octocode-tools-core/schema';
import { OCTOCODE_DIRECT_TOOL_NAMES } from '../constants.js';
import { recordFileReadState } from './edit-tool.js';
// ─── Shared rendering helpers (ANSI truncation + smart call/result renderers) ──
import { buildOctocodeRenderCall, buildOctocodeRenderResult, } from './render-helpers.js';
// ─── Tool metadata helpers ────────────────────────────────────────────────────
let octocodeToolMetadataPromise = null;
async function getOctocodeToolMetadata() {
    if (!octocodeToolMetadataPromise) {
        octocodeToolMetadataPromise = loadToolContent().catch(() => null);
    }
    return octocodeToolMetadataPromise;
}
async function getOctocodeToolSchema(toolName) {
    const metadata = await getOctocodeToolMetadata();
    const fullDescription = getCoreDirectToolDescription(toolName, metadata);
    return {
        kind: 'octocode.toolSchema',
        version: 1,
        name: toolName,
        category: getCoreDirectToolCategory(toolName),
        description: firstSentence(fullDescription),
        fullDescription,
        inputSchema: JSON.parse(formatDirectToolSchemaText(toolName)),
    };
}
// ─── Private helpers ─────────────────────────────────────────────────────────
function toTitleCaseName(toolName) {
    return toolName
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/^gh\b/, 'GitHub')
        .replace(/^npm\b/, 'npm')
        .replace(/^lsp\b/, 'LSP')
        .replace(/^local\b/, 'Local')
        .trim();
}
function firstSentence(text) {
    const normalized = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    if (normalized.length === 0)
        return '';
    const pipeParts = normalized
        .split(/\s+\|\s+/)
        .map((part) => part.trim())
        .filter(Boolean);
    return (pipeParts.find((part) => part.length > 0 &&
        !/^(github|local|npm|package|search|other)$/i.test(part)) ?? normalized);
}
function buildOctocodeToolGuidelines(toolName) {
    const guidelines = [
        `${toolName} is a native Pi tool backed by the bundled Octocode CLI tools command; pass arguments using this tool's Pi schema directly.`,
    ];
    if (toolName.startsWith('local') || toolName.startsWith('lsp')) {
        guidelines.push(`${toolName} local paths should be absolute when possible; strip a leading @ if the model copied a Pi file reference.`);
    }
    if (toolName === 'localSearchCode') {
        guidelines.push('Use localSearchCode mode:"discovery" for paths first, then localGetFileContent for exact slices.');
    }
    return guidelines;
}
function getToolFieldPreview(schema) {
    const required = Array.isArray(schema.inputSchema['required'])
        ? schema.inputSchema['required']
        : [];
    return required.slice(0, 4).join(', ');
}
function buildOctocodeToolParameters(Type, schema) {
    return Type.Unsafe(schema.inputSchema);
}
function getOctocodeToolCategory(schema) {
    return typeof schema.category === 'string' ? schema.category : 'Octocode';
}
async function executeOctocodeToolForPi(toolName, params, signal, ctx) {
    if (signal?.aborted)
        throw new Error(`Octocode tool ${toolName} was cancelled before it started.`);
    const { setRuntimeSurface, invalidateConfigCache } = await import('@octocodeai/octocode-tools-core/config');
    const { executeDirectTool } = await import('@octocodeai/octocode-tools-core/direct');
    setRuntimeSurface('cli');
    invalidateConfigCache();
    const result = (await executeDirectTool(toolName, params));
    if (signal?.aborted)
        throw new Error(`Octocode tool ${toolName} was cancelled.`);
    const details = result.structuredContent ?? result;
    const content = Array.isArray(result.content) && result.content.length > 0
        ? result.content
        : [{ type: 'text', text: JSON.stringify(details) }];
    if (result.isError) {
        const text = content.find((part) => part.type === 'text')?.text ?? JSON.stringify(details);
        throw new Error(text);
    }
    if (toolName === 'localGetFileContent') {
        await recordLocalGetFileContentReads(params, ctx?.cwd ?? process.cwd());
    }
    return {
        content,
        details,
    };
}
async function recordLocalGetFileContentReads(params, cwd) {
    const queries = Array.isArray(params['queries']) ? params['queries'] : [];
    await Promise.all(queries.map(async (query) => {
        if (!query || typeof query !== 'object')
            return;
        const filePath = query['path'];
        if (typeof filePath !== 'string' || filePath.trim().length === 0)
            return;
        try {
            await recordFileReadState(filePath, cwd);
        }
        catch {
            // Read-state tracking is an edit-safety enhancement; never fail localGetFileContent because tracking failed.
        }
    }));
}
// ─── Registration ─────────────────────────────────────────────────────────────
export function registerUniqueTool(pi, registeredToolNames, toolDefinition) {
    if (registeredToolNames.has(toolDefinition.name)) {
        throw new Error(`Octocode Pi extension tool name collision: ${toolDefinition.name}`);
    }
    registeredToolNames.add(toolDefinition.name);
    pi.registerTool?.(toolDefinition);
}
export async function registerOctocodeTools(pi, Type, registeredToolNames) {
    for (const toolName of OCTOCODE_DIRECT_TOOL_NAMES) {
        let schema;
        try {
            schema = await getOctocodeToolSchema(toolName);
        }
        catch (error) {
            // A malformed schema for ONE tool (e.g. bad JSON from core) must not take
            // down registration of the other 12. Skip it and continue.
            // eslint-disable-next-line no-console
            console.error(`Octocode: skipping tool "${toolName}" — schema load failed: ${error?.message ?? error}`);
            continue;
        }
        const description = schema.fullDescription || schema.description || `${toolName} Octocode tool`;
        const fieldPreview = getToolFieldPreview(schema);
        const promptSnippet = fieldPreview
            ? `${firstSentence(description)} Required: ${fieldPreview}.`
            : firstSentence(description);
        registerUniqueTool(pi, registeredToolNames, {
            name: toolName,
            label: `${getOctocodeToolCategory(schema)}: ${toTitleCaseName(toolName)}`,
            description,
            promptSnippet,
            promptGuidelines: buildOctocodeToolGuidelines(toolName),
            parameters: buildOctocodeToolParameters(Type, schema),
            async execute(_toolCallId, params, signal, _onUpdate, ctx) {
                return executeOctocodeToolForPi(toolName, params, signal, ctx);
            },
            renderCall(args, theme) {
                // Smart per-tool-category call summary: shows keywords, owner/repo, path, symbol, etc.
                return buildOctocodeRenderCall(toolName, args, theme);
            },
            renderResult(result, opts, theme) {
                // Smart per-tool-category result stats: match counts, file paths, repo names, etc.
                return buildOctocodeRenderResult(toolName, result, opts, theme);
            },
        });
    }
}
