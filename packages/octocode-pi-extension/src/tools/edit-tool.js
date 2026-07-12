import { constants } from 'node:fs';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { makeRenderer, truncateToWidth, wrapText } from './render-helpers.js';
import { assertPathAllowed } from './path-guard.js';
const require = createRequire(import.meta.url);
const readStates = new Map();
// ─── File mutation queue ──────────────────────────────────────────────────────
// Per-file serialization queue: ensures that parallel tool calls on the same
// file don't race (read-modify-write is atomic within each file's queue).
// Equivalent to Pi's withFileMutationQueue from @earendil-works/pi-coding-agent,
// implemented locally since that package is not a declared dependency.
const fileQueues = new Map();
export function withFileMutationQueue(key, fn) {
    // Get the current settled tail (always resolves, never rejects)
    const prev = fileQueues.get(key) ?? Promise.resolve();
    // Schedule fn after prev settles
    const execution = prev.then(() => fn());
    // New tail: suppress errors so future operations still run
    const tail = execution.then(() => { }, () => { });
    fileQueues.set(key, tail);
    // Clean up once this tail settles (no further operations queued)
    void tail.then(() => { if (fileQueues.get(key) === tail)
        fileQueues.delete(key); });
    return execution;
}
const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';
function normalizeToLF(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function detectLineEnding(text) {
    return text.includes('\r\n') ? '\r\n' : '\n';
}
function restoreLineEndings(text, ending) {
    return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}
function stripBom(text) {
    return text.startsWith('\uFEFF') ? { bom: '\uFEFF', text: text.slice(1) } : { bom: '', text };
}
function contentHash(text) {
    return createHash('sha256').update(text).digest('hex');
}
function resolveEditPath(filePath, cwd = process.cwd()) {
    return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}
export async function recordFileReadState(filePath, cwd = process.cwd()) {
    const absolutePath = resolveEditPath(filePath, cwd);
    const [stats, content] = await Promise.all([stat(absolutePath), readFile(absolutePath, 'utf8')]);
    readStates.set(absolutePath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        contentHash: contentHash(content),
        readAt: Date.now(),
    });
}
export function clearEditReadStateForTests() {
    readStates.clear();
}
async function checkReadState(absolutePath, requireRecentRead) {
    const state = readStates.get(absolutePath);
    if (!state) {
        const message = 'No prior localGetFileContent read state recorded for this file.';
        if (requireRecentRead)
            throw new Error(`${message} Re-read the file before editing or set requireRecentRead:false intentionally.`);
        return { state: 'missing', message };
    }
    // Fast path: mtime AND size unchanged => definitively not stale; skip the hash read.
    // If either differs, fall back to the authoritative content hash so an
    // identical-content re-write (e.g. editor that reformats-on-save but yields
    // the same bytes) is NOT falsely reported stale. mtime/size are cheap
    // pre-checks; the hash is the source of truth.
    const stats = await stat(absolutePath);
    let stale;
    if (stats.mtimeMs === state.mtimeMs && stats.size === state.size) {
        stale = false;
    }
    else {
        const current = await readFile(absolutePath, 'utf8');
        stale = contentHash(current) !== state.contentHash;
    }
    if (stale) {
        throw new Error('File changed since last recorded read. Re-read the target range before editing.');
    }
    return { state: 'fresh', message: `Fresh read state recorded ${Math.max(0, Date.now() - state.readAt)}ms ago.` };
}
function findOccurrences(content, needle) {
    if (needle.length === 0)
        return [];
    const indices = [];
    let index = content.indexOf(needle);
    while (index !== -1) {
        indices.push(index);
        index = content.indexOf(needle, index + needle.length);
    }
    return indices;
}
function firstChangedLine(oldContent, newContent) {
    if (oldContent === newContent)
        return undefined;
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const max = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < max; i++) {
        if (oldLines[i] !== newLines[i])
            return i + 1;
    }
    return undefined;
}
function normalizeForFuzzyMatch(text) {
    return text
        .normalize('NFKC')
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
        .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}
function lineSpans(content) {
    const lines = content.split('\n');
    let cursor = 0;
    return lines.map((line, index) => {
        const hasNewline = index < lines.length - 1;
        const end = cursor + line.length + (hasNewline ? 1 : 0);
        const span = { start: cursor, end, line: hasNewline ? `${line}\n` : line };
        cursor = end;
        return span;
    });
}
function previewLine(line) {
    const visible = line
        .replace(/^ +/u, (spaces) => '·'.repeat(spaces.length))
        .replace(/^\t+/u, (tabs) => '→'.repeat(tabs.length));
    return visible.length > 160 ? `${visible.slice(0, 160)}…` : visible;
}
function getSearchAnchor(oldText) {
    const lines = normalizeToLF(oldText)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    return lines[0] ?? null;
}
function buildNearbyLineHints(content, oldText) {
    const anchor = getSearchAnchor(oldText);
    if (!anchor)
        return [];
    const candidates = [anchor, anchor.slice(0, 80), anchor.slice(0, 40)]
        .map((candidate) => candidate.trim())
        .filter((candidate, index, all) => candidate.length >= 8 && all.indexOf(candidate) === index);
    const lines = content.split('\n');
    const hints = [];
    for (const candidate of candidates) {
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].includes(candidate))
                continue;
            hints.push(`line ${i + 1}: ${previewLine(lines[i])}`);
            if (hints.length >= 5)
                return hints;
        }
    }
    return hints;
}
function notFoundError(filePath, editIndex, totalEdits, oldText, content) {
    const target = totalEdits === 1 ? 'oldText' : `edits[${editIndex}].oldText`;
    const anchor = getSearchAnchor(oldText);
    const hints = buildNearbyLineHints(content, oldText);
    const details = [
        `Could not find ${target} in ${filePath}.`,
        'The custom Octocode edit tool matches current file text exactly unless matchMode is explicitly set.',
        'Likely causes: the file changed since it was last read, oldText came from a sibling/generated file, or whitespace/indentation differs.',
        anchor ? `Longest non-empty oldText line: ${JSON.stringify(previewLine(anchor))}` : undefined,
        hints.length > 0 ? `Current file lines containing a similar anchor:\n${hints.map((hint) => `  - ${hint}`).join('\n')}` : undefined,
        'Re-read the target range and retry with a smaller unique oldText copied from the current file.',
    ].filter((line) => Boolean(line));
    return new Error(details.join('\n'));
}
function duplicateError(filePath, editIndex, totalEdits, occurrences) {
    const target = totalEdits === 1 ? 'oldText' : `edits[${editIndex}].oldText`;
    return new Error(`Found ${occurrences} occurrences of ${target} in ${filePath}. ` +
        'The text must be unique unless replaceAll:true is set for this edit. ' +
        'Provide more surrounding context or intentionally use replaceAll:true.');
}
function assertIntegerLine(value, name, editIndex) {
    if (!Number.isInteger(value) || Number(value) < 1) {
        throw new Error(`Edit tool input is invalid. edits[${editIndex}].${name} must be a positive integer.`);
    }
    return Number(value);
}
function validateOperation(edit, index) {
    if (!edit || typeof edit !== 'object') {
        throw new Error(`Edit tool input is invalid. edits[${index}] must be an object.`);
    }
    const item = edit;
    const matchMode = (item['matchMode'] ?? 'exact');
    if (!['exact', 'normalized', 'lineRange'].includes(matchMode)) {
        throw new Error(`Edit tool input is invalid. edits[${index}].matchMode must be exact, normalized, or lineRange.`);
    }
    if (typeof item['newText'] !== 'string') {
        throw new Error(`Edit tool input is invalid. edits[${index}].newText must be a string.`);
    }
    if (item['oldText'] !== undefined && typeof item['oldText'] !== 'string') {
        throw new Error(`Edit tool input is invalid. edits[${index}].oldText must be a string.`);
    }
    if (matchMode !== 'lineRange' && (typeof item['oldText'] !== 'string' || item['oldText'].length === 0)) {
        throw new Error(`Edit tool input is invalid. edits[${index}].oldText must be a non-empty string unless matchMode:"lineRange" is used.`);
    }
    if (item['oldText'] === '') {
        throw new Error(`Edit tool input is invalid. edits[${index}].oldText must not be empty.`);
    }
    if (item['replaceAll'] !== undefined && typeof item['replaceAll'] !== 'boolean') {
        throw new Error(`Edit tool input is invalid. edits[${index}].replaceAll must be a boolean.`);
    }
    if (typeof item['reasoning'] !== 'string' || item['reasoning'].trim().length === 0) {
        throw new Error(`Edit tool input is invalid. edits[${index}].reasoning is required — provide a non-empty string explaining why this edit is necessary.`);
    }
    const operation = {
        oldText: item['oldText'],
        newText: item['newText'],
        replaceAll: item['replaceAll'] === true,
        reasoning: item['reasoning'],
        matchMode,
    };
    if (matchMode === 'lineRange') {
        operation.startLine = assertIntegerLine(item['startLine'], 'startLine', index);
        operation.endLine = assertIntegerLine(item['endLine'], 'endLine', index);
        if (operation.endLine < operation.startLine) {
            throw new Error(`Edit tool input is invalid. edits[${index}].endLine must be >= startLine.`);
        }
        if (operation.replaceAll) {
            throw new Error(`Edit tool input is invalid. edits[${index}].replaceAll cannot be used with matchMode:"lineRange".`);
        }
    }
    return operation;
}
function validateRequest(input) {
    const hasQueries = input['queries'] !== undefined;
    const hasSingle = input['path'] !== undefined || input['edits'] !== undefined;
    if (hasQueries && hasSingle) {
        throw new Error('Edit tool input is invalid. Use either path+edits or queries, not both.');
    }
    if (hasQueries) {
        if (!Array.isArray(input['queries']) || input['queries'].length === 0) {
            throw new Error('Edit tool input is invalid. queries must be a non-empty array.');
        }
        return {
            requireRecentRead: input['requireRecentRead'] === true,
            queries: input['queries'].map((query, queryIndex) => {
                if (!query || typeof query !== 'object')
                    throw new Error(`Edit tool input is invalid. queries[${queryIndex}] must be an object.`);
                const item = query;
                if (typeof item['path'] !== 'string' || item['path'].trim().length === 0)
                    throw new Error(`Edit tool input is invalid. queries[${queryIndex}].path must be a non-empty string.`);
                if (!Array.isArray(item['edits']) || item['edits'].length === 0)
                    throw new Error(`Edit tool input is invalid. queries[${queryIndex}].edits must contain at least one replacement.`);
                return {
                    path: item['path'],
                    requireRecentRead: item['requireRecentRead'] === true,
                    edits: item['edits'].map(validateOperation),
                };
            }),
        };
    }
    if (typeof input['path'] !== 'string' || input['path'].trim().length === 0) {
        throw new Error('Edit tool input is invalid. path must be a non-empty string.');
    }
    if (!Array.isArray(input['edits']) || input['edits'].length === 0) {
        throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
    }
    return {
        path: input['path'],
        requireRecentRead: input['requireRecentRead'] === true,
        edits: input['edits'].map(validateOperation),
    };
}
function exactReplacements(content, edit, editIndex, totalEdits, filePath) {
    const oldText = normalizeToLF(edit.oldText ?? '');
    const occurrences = findOccurrences(content, oldText);
    if (occurrences.length === 0)
        throw notFoundError(filePath, editIndex, totalEdits, oldText, content);
    if (!edit.replaceAll && occurrences.length > 1)
        throw duplicateError(filePath, editIndex, totalEdits, occurrences.length);
    return (edit.replaceAll ? occurrences : [occurrences[0]]).map((start) => ({
        editIndex,
        start,
        end: start + oldText.length,
        newText: normalizeToLF(edit.newText),
        mode: 'exact',
    }));
}
function normalizedReplacements(content, edit, editIndex, totalEdits, filePath) {
    const oldText = normalizeToLF(edit.oldText ?? '');
    const normalizedOld = normalizeForFuzzyMatch(oldText);
    const spans = lineSpans(content);
    const oldLineCount = oldText.split('\n').length;
    const matches = [];
    for (let i = 0; i <= spans.length - oldLineCount; i++) {
        const candidate = spans.slice(i, i + oldLineCount).map((span) => span.line).join('');
        if (normalizeForFuzzyMatch(candidate) === normalizedOld) {
            matches.push({
                editIndex,
                start: spans[i].start,
                end: spans[i + oldLineCount - 1].end,
                newText: normalizeToLF(edit.newText),
                mode: 'normalized',
            });
        }
    }
    if (matches.length === 0)
        throw notFoundError(filePath, editIndex, totalEdits, oldText, content);
    if (!edit.replaceAll && matches.length > 1)
        throw duplicateError(filePath, editIndex, totalEdits, matches.length);
    return edit.replaceAll ? matches : [matches[0]];
}
function lineRangeReplacement(content, edit, editIndex, filePath) {
    const spans = lineSpans(content);
    const startLine = edit.startLine;
    const endLine = edit.endLine;
    if (startLine > spans.length || endLine > spans.length) {
        throw new Error(`edits[${editIndex}] line range ${startLine}-${endLine} is outside ${filePath} (${spans.length} lines).`);
    }
    const start = spans[startLine - 1].start;
    const end = spans[endLine - 1].end;
    const current = content.slice(start, end);
    if (edit.oldText !== undefined && normalizeToLF(edit.oldText) !== current) {
        throw new Error(`edits[${editIndex}] oldText does not match the requested line range in ${filePath}. Re-read the target range.`);
    }
    return [{ editIndex, start, end, newText: normalizeToLF(edit.newText), mode: 'lineRange' }];
}
export function applyCustomEditsToContent(content, edits, filePath) {
    const replacements = [];
    for (let editIndex = 0; editIndex < edits.length; editIndex++) {
        const edit = edits[editIndex];
        const mode = edit.matchMode ?? 'exact';
        if (mode === 'lineRange')
            replacements.push(...lineRangeReplacement(content, edit, editIndex, filePath));
        else if (mode === 'normalized')
            replacements.push(...normalizedReplacements(content, edit, editIndex, edits.length, filePath));
        else
            replacements.push(...exactReplacements(content, edit, editIndex, edits.length, filePath));
    }
    replacements.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < replacements.length; i++) {
        const previous = replacements[i - 1];
        const current = replacements[i];
        if (previous.end > current.start) {
            throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${filePath}. ` +
                'Merge them into one edit or target disjoint regions.');
        }
    }
    let newContent = content;
    for (let i = replacements.length - 1; i >= 0; i--) {
        const replacement = replacements[i];
        newContent = `${newContent.slice(0, replacement.start)}${replacement.newText}${newContent.slice(replacement.end)}`;
    }
    if (newContent === content) {
        throw new Error(`No changes made to ${filePath}. The replacement produced identical content.`);
    }
    // Build per-edit evidence: group replacements by editIndex, compute original-file
    // line ranges from byte offsets, and derive removed/added line fragments.
    const spanLines = lineSpans(content);
    const byteToLineRange = (start, end) => {
        // 1-based start line containing `start`; end line containing the char before `end`.
        let startLine = 1;
        let endLine = 1;
        for (let i = 0; i < spanLines.length; i++) {
            const span = spanLines[i];
            if (start >= span.start && start < span.end)
                startLine = i + 1;
            if (end > span.start && end <= span.end)
                endLine = i + 1;
        }
        // end may point just past a trailing newline — clamp to last line.
        if (endLine < startLine)
            endLine = startLine;
        return { startLine, endLine };
    };
    const editEvidenceMap = new Map();
    // Split text into display lines, stripping a single trailing newline so a line
    // that includes its own newline boundary doesn't produce a phantom empty line.
    // removedLines must reflect the ACTUAL bytes removed from the ORIGINAL file
    // (content.slice), not edit.oldText — which for normalized/lineRange matching
    // can differ from the original by normalization (e.g. ﬁ ligature, CRLF).
    const toLines = (text) => {
        const stripped = text.endsWith('\n') ? text.slice(0, -1) : text;
        return stripped.split('\n');
    };
    for (const r of replacements) {
        const edit = edits[r.editIndex];
        const removedText = normalizeToLF(content.slice(r.start, r.end));
        const range = byteToLineRange(r.start, r.end);
        const existing = editEvidenceMap.get(r.editIndex);
        if (existing) {
            // Multiple occurrences (replaceAll): widen the line range + accumulate fragments.
            existing.startLine = Math.min(existing.startLine, range.startLine);
            existing.endLine = Math.max(existing.endLine, range.endLine);
            existing.removedLines.push(...toLines(removedText));
            existing.addedLines.push(...toLines(r.newText));
        }
        else {
            editEvidenceMap.set(r.editIndex, {
                editIndex: r.editIndex,
                startLine: range.startLine,
                endLine: range.endLine,
                mode: r.mode,
                reasoning: edit.reasoning.trim(),
                removedLines: toLines(removedText),
                addedLines: toLines(r.newText),
            });
        }
    }
    const editEvidence = [...editEvidenceMap.values()].sort((a, b) => a.editIndex - b.editIndex);
    return {
        baseContent: content,
        newContent,
        replacements: replacements.length,
        firstChangedLine: firstChangedLine(content, newContent),
        usedModes: [...new Set(replacements.map((replacement) => replacement.mode))],
        edits: editEvidence,
    };
}
// Myers line diff is O((N+M)·D). Agent edits are almost always small D on large
// files, so this stays fast where the old LCS DP (O(N·M) time+memory) stalled
// (~230ms at 3k lines) and forced MAX_DIFF_LINES=6000 omit. Cap only for
// pathological total size / memory, not for ordinary mid-size source files.
const MAX_DIFF_LINES = 200_000;
function diffTooLarge(oldContent, newContent) {
    // Cheap length pre-check avoids splitting huge buffers just to count lines.
    if (oldContent.length + newContent.length > 32 * 1024 * 1024)
        return true;
    return oldContent.split('\n').length + newContent.split('\n').length > MAX_DIFF_LINES;
}
/**
 * Myers O((N+M)D) line diff. Returns a full edit script of same/add/remove ops.
 * Default: pure JS Myers (typically sub-ms for agent-sized edits).
 * Opt-in native engine path via OCTOCODE_EDIT_NATIVE_DIFF=1 (useful for release
 * napi builds / shared CLI callers; debug napi can be slower than JS).
 * Exported for unit/perf tests.
 */
export function diffOps(oldContent, newContent) {
    if (process.env['OCTOCODE_EDIT_NATIVE_DIFF'] === '1') {
        const native = tryNativeDiffOps(oldContent, newContent);
        if (native)
            return native;
    }
    return diffOpsJs(oldContent, newContent);
}
let nativeComputeLineDiff;
function tryNativeDiffOps(oldContent, newContent) {
    if (nativeComputeLineDiff === undefined) {
        try {
            const eng = require('@octocodeai/octocode-engine');
            nativeComputeLineDiff =
                typeof eng.computeLineDiff === 'function' ? eng.computeLineDiff.bind(eng) : null;
        }
        catch {
            nativeComputeLineDiff = null;
        }
    }
    if (!nativeComputeLineDiff)
        return null;
    try {
        const ops = nativeComputeLineDiff(oldContent, newContent);
        return ops.map((op) => ({
            type: op.opType,
            line: op.line,
        }));
    }
    catch {
        return null;
    }
}
/** Pure JS Myers — used when the native addon is unavailable. */
export function diffOpsJs(oldContent, newContent) {
    const a = oldContent.split('\n');
    const b = newContent.split('\n');
    const n = a.length;
    const m = b.length;
    if (n === 0 && m === 0)
        return [];
    if (n === 0)
        return b.map((line) => ({ type: 'add', line }));
    if (m === 0)
        return a.map((line) => ({ type: 'remove', line }));
    const max = n + m;
    const offset = max;
    const v = new Int32Array(2 * max + 1);
    v.fill(-1);
    v[offset + 1] = 0;
    const trace = [];
    let dFound = -1;
    outer: for (let d = 0; d <= max; d++) {
        for (let k = -d; k <= d; k += 2) {
            let x;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
                x = v[offset + k + 1];
            }
            else {
                x = v[offset + k - 1] + 1;
            }
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                trace.push(Int32Array.from(v));
                dFound = d;
                break outer;
            }
        }
        trace.push(Int32Array.from(v));
    }
    if (dFound < 0) {
        return [
            ...a.map((line) => ({ type: 'remove', line })),
            ...b.map((line) => ({ type: 'add', line })),
        ];
    }
    const opsRev = [];
    let x = n;
    let y = m;
    for (let d = dFound; d > 0; d--) {
        const vPrev = trace[d - 1];
        const k = x - y;
        let prevK;
        if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
            prevK = k + 1;
        }
        else {
            prevK = k - 1;
        }
        const prevX = vPrev[offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            x--;
            y--;
            opsRev.push({ type: 'same', line: a[x] });
        }
        if (x === prevX) {
            y--;
            opsRev.push({ type: 'add', line: b[y] });
        }
        else {
            x--;
            opsRev.push({ type: 'remove', line: a[x] });
        }
    }
    while (x > 0 && y > 0) {
        x--;
        y--;
        opsRev.push({ type: 'same', line: a[x] });
    }
    while (x > 0) {
        x--;
        opsRev.push({ type: 'remove', line: a[x] });
    }
    while (y > 0) {
        y--;
        opsRev.push({ type: 'add', line: b[y] });
    }
    opsRev.reverse();
    return opsRev;
}
export function generateDiffString(oldContent, newContent) {
    if (diffTooLarge(oldContent, newContent)) {
        return '(diff omitted: file too large — see the per-edit changes in details)';
    }
    return diffOps(oldContent, newContent)
        .filter((op) => op.type !== 'same')
        .map((op) => `${op.type === 'add' ? '+' : '-'} ${op.line}`)
        .join('\n');
}
function colorDiffLine(line) {
    if (line.startsWith('+ '))
        return `${ANSI_GREEN}${line}${ANSI_RESET}`;
    if (line.startsWith('- '))
        return `${ANSI_RED}${line}${ANSI_RESET}`;
    return line;
}
function colorDiffString(diff) {
    return diff.split('\n').map(colorDiffLine).join('\n');
}
/** Build diff + unified patch from a single Myers pass (no double O(ND)). */
export function generateDiffArtifacts(filePath, oldContent, newContent) {
    if (diffTooLarge(oldContent, newContent)) {
        return {
            diff: '(diff omitted: file too large — see the per-edit changes in details)',
            patch: `--- ${filePath}\n+++ ${filePath}\n@@ patch omitted: file too large @@\n`,
            ops: [],
        };
    }
    const ops = diffOps(oldContent, newContent);
    const diff = ops
        .filter((op) => op.type !== 'same')
        .map((op) => `${op.type === 'add' ? '+' : '-'} ${op.line}`)
        .join('\n');
    let start = 0;
    while (start < ops.length && ops[start].type === 'same')
        start++;
    let end = ops.length;
    while (end > start && ops[end - 1].type === 'same')
        end--;
    const hunkOps = ops.slice(start, end);
    const oldCount = hunkOps.filter((op) => op.type !== 'add').length;
    const newCount = hunkOps.filter((op) => op.type !== 'remove').length;
    const oldStart = start + 1;
    const newStart = start + 1;
    const lines = [`--- ${filePath}`, `+++ ${filePath}`, `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
    for (const op of hunkOps) {
        if (op.type === 'same')
            lines.push(` ${op.line}`);
        else
            lines.push(`${op.type === 'add' ? '+' : '-'}${op.line}`);
    }
    return { diff, patch: `${lines.join('\n')}\n`, ops };
}
function buildParameters(Type) {
    const editOperation = Type.Object({
        oldText: Type.Optional(Type.String({
            description: 'Exact text for one targeted replacement. Required unless matchMode:"lineRange" is used.',
        })),
        newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
        replaceAll: Type.Optional(Type.Boolean({
            description: 'Replace every occurrence of oldText. Default false; use only for intentional file-wide replacements.',
        })),
        reasoning: Type.String({
            description: 'REQUIRED. Why this edit is necessary. Must be a non-empty explanation; shown in the output reasoning list and audit trail.',
        }),
        matchMode: Type.Optional(Type.Unsafe({ type: 'string', enum: ['exact', 'normalized', 'lineRange'], description: 'Matching strategy. Default exact. normalized is opt-in fuzzy normalization; lineRange uses startLine/endLine.' })),
        startLine: Type.Optional(Type.Integer({ minimum: 1, description: '1-based start line for matchMode:"lineRange".' })),
        endLine: Type.Optional(Type.Integer({ minimum: 1, description: '1-based inclusive end line for matchMode:"lineRange".' })),
    }, { additionalProperties: false });
    return Type.Object({
        path: Type.Optional(Type.String({ description: 'Path to the file to edit (relative or absolute)' })),
        edits: Type.Optional(Type.Array(editOperation, {
            description: 'One or more targeted replacements. Edits are matched against the original file content, not after earlier replacements.',
        })),
        queries: Type.Optional(Type.Array(Type.Object({
            path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
            edits: Type.Array(editOperation),
            requireRecentRead: Type.Optional(Type.Boolean({ description: 'Require a fresh recorded localGetFileContent read before editing this file.' })),
        }, { additionalProperties: false }), { description: 'Multi-file edit requests. All replacements are computed before any file is written.' })),
        requireRecentRead: Type.Optional(Type.Boolean({ description: 'Require a fresh recorded localGetFileContent read before editing.' })),
    }, { additionalProperties: false });
}
function renderCallLine(args, theme) {
    const input = args && typeof args === 'object' ? args : {};
    const queries = Array.isArray(input['queries']) ? input['queries'].length : 0;
    const filePath = queries > 0 ? `${queries} file${queries === 1 ? '' : 's'}` : typeof input['path'] === 'string' ? input['path'] : '(missing path)';
    const edits = Array.isArray(input['edits']) ? input['edits'].length : queries;
    const title = theme?.fg('toolTitle', theme.bold('edit')) ?? 'edit';
    const suffix = theme?.fg('dim', `${filePath} · ${edits} edit${edits === 1 ? '' : 's'}`) ?? `${filePath} · ${edits} edit${edits === 1 ? '' : 's'}`;
    return `${title} ${suffix}`;
}
function editReasoningEntries(edits) {
    return edits.map((edit, index) => ({ editIndex: index, reasoning: edit.reasoning.trim() }));
}
function reasoningSuffix(editsByFile) {
    const lines = editsByFile.flatMap((file) => editReasoningEntries(file.edits)
        .map((entry) => `${file.path} edits[${entry.editIndex}]: ${entry.reasoning}`));
    return lines.length > 0 ? `\nReasoning:\n${lines.map((line) => `- ${line}`).join('\n')}` : '';
}
function changesSuffix(prepared) {
    const blocks = prepared.map((item) => `# ${item.requestPath}\n${colorDiffString(item.diff)}`);
    return `\nChanges:\n${blocks.join('\n')}`;
}
async function prepareEdit(query, cwd, inheritedRequireRecentRead) {
    const absolutePath = resolveEditPath(query.path, cwd);
    // Bound writes to home + ALLOWED_PATHS + cwd/tmp (same model as the native tools).
    assertPathAllowed(absolutePath, cwd, 'edit');
    await access(absolutePath, constants.R_OK | constants.W_OK);
    const readState = await checkReadState(absolutePath, inheritedRequireRecentRead || query.requireRecentRead === true);
    const rawContent = await readFile(absolutePath, 'utf8');
    const { bom, text } = stripBom(rawContent);
    const lineEnding = detectLineEnding(text);
    const normalizedContent = normalizeToLF(text);
    const result = applyCustomEditsToContent(normalizedContent, query.edits, query.path);
    const finalContent = bom + restoreLineEndings(result.newContent, lineEnding);
    const artifacts = generateDiffArtifacts(query.path, result.baseContent, result.newContent);
    return {
        requestPath: query.path,
        absolutePath,
        edits: query.edits,
        requireRecentRead: inheritedRequireRecentRead || query.requireRecentRead === true,
        rawContent,
        finalContent,
        result,
        readState,
        diff: artifacts.diff,
        patch: artifacts.patch,
    };
}
function queriesFromRequest(request) {
    if (request.queries)
        return request.queries;
    return [{ path: request.path, edits: request.edits, requireRecentRead: request.requireRecentRead }];
}
export function registerEditTool(pi, Type) {
    pi.registerTool?.({
        name: 'edit',
        label: 'edit (Octocode)',
        description: 'Octocode custom edit tool. Replaces Pi built-in edit with exact current-file text replacement, batched edits, optional multi-file queries, opt-in normalized/lineRange matching, stale-read checks, diff/patch details, optional replaceAll, and actionable mismatch diagnostics. Each edit MUST include a non-empty reasoning field. Output always shows a Reasoning list and Changes diff.',
        promptSnippet: 'Make precise file edits with exact current-file text replacement and clearer mismatch diagnostics.',
        promptGuidelines: [
            'Octocode custom edit replaces Pi built-in edit; use this edit tool for file modifications.',
            'Before editing files that may have changed, re-read the target range with localGetFileContent so stale edits can be detected.',
            'Each edits[].oldText is matched against the original file content, not after earlier edits are applied.',
            'Use replaceAll:true only for intentional file-wide replacements; otherwise oldText must be unique.',
            'Use matchMode:"normalized" for whitespace/indentation/unicode quote/dash drift when exact bytes copied from localGetFileContent do not match; use matchMode:"lineRange" only with freshly read line numbers.',
            'Use queries[] for multi-file edits only when every file belongs to the same logical change; all replacements are computed before writing.',
            'edits[].reasoning is REQUIRED for every edit — provide a non-empty string explaining why the change is necessary; edits without reasoning are rejected.',
            'Every edit output includes a Reasoning list and a Changes diff; read both to verify correctness before continuing.',
            'If edit reports oldText not found, re-read the current target range and retry with a smaller unique oldText.',
            'GOTCHA: Read and understand the file before editing; run `node $OCTOCODE_AWARENESS_CLI workspace status --compact` to inspect peers with the file under work and any exclusive conflict. Advisory overlap is allowed; an exclusive lock blocks.',
            'GOTCHA: For multiple repetitive or mechanical changes across a file (e.g. renaming a symbol everywhere, bulk formatting), prefer shell commands like sed instead of many individual edit calls.',
        ],
        parameters: buildParameters(Type),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const request = validateRequest(params);
            const cwd = ctx?.cwd ?? process.cwd();
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const queries = queriesFromRequest(request);
            const absolutePaths = queries.map((query) => resolveEditPath(query.path, cwd));
            if (new Set(absolutePaths).size !== absolutePaths.length) {
                throw new Error('Edit tool input is invalid. queries must not contain duplicate target paths.');
            }
            // Phase 1: prepare all files (read-only, parallel).
            // If any prepare fails (bad oldText, missing file, etc.) no writes happen → all-or-nothing.
            const prepared = await Promise.all(queries.map((query) => prepareEdit(query, cwd, request.requireRecentRead === true)));
            if (signal?.aborted)
                throw new Error('Operation aborted');
            // Phase 2: write each file through its per-file mutex queue.
            // Serializes concurrent writes from parallel tool calls on the same file.
            await Promise.all(prepared.map((item) => withFileMutationQueue(item.absolutePath, async () => {
                if (signal?.aborted)
                    throw new Error('Operation aborted');
                // Lost-update guard: prepareEdit computed finalContent from item.rawContent
                // OUTSIDE this mutex. If a concurrent edit call (or external writer) changed
                // the file since then, writing finalContent would silently clobber it. Re-read
                // under the lock and fail loudly instead of losing the intervening change.
                const currentRaw = await readFile(item.absolutePath, 'utf8');
                if (currentRaw !== item.rawContent) {
                    throw new Error(`${item.requestPath} changed on disk after it was read for editing ` +
                        `(concurrent edit or external write). Re-read the file and retry.`);
                }
                await writeFile(item.absolutePath, item.finalContent, 'utf8');
                await recordFileReadState(item.absolutePath);
            })));
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const replacements = prepared.reduce((sum, item) => sum + item.result.replacements, 0);
            const editCount = prepared.reduce((sum, item) => sum + item.edits.length, 0);
            const firstChangedLine = prepared.find((item) => item.result.firstChangedLine !== undefined)?.result.firstChangedLine;
            const lineSuffix = firstChangedLine ? ` First changed line: ${firstChangedLine}.` : '';
            const readStates = [...new Set(prepared.map((item) => item.readState.state))].join(',');
            const reasoning = reasoningSuffix(prepared.map((item) => ({ path: item.requestPath, edits: item.edits })));
            const changes = changesSuffix(prepared);
            return {
                content: [{
                        type: 'text',
                        text: `Successfully replaced ${replacements} occurrence(s) across ${editCount} edit(s) in ${prepared.length} file(s).${lineSuffix} Read state: ${readStates}.${reasoning}${changes}`,
                    }],
                details: {
                    replacements,
                    firstChangedLine,
                    files: prepared.map((item) => ({
                        path: item.requestPath,
                        replacements: item.result.replacements,
                        firstChangedLine: item.result.firstChangedLine,
                        usedModes: item.result.usedModes,
                        readState: item.readState,
                        reasoning: editReasoningEntries(item.edits),
                        edits: item.result.edits,
                        diff: item.diff,
                        coloredDiff: colorDiffString(item.diff),
                        patch: item.patch,
                    })),
                    diff: prepared.map((item) => `# ${item.requestPath}\n${item.diff}`).join('\n'),
                    patch: prepared.map((item) => item.patch).join('\n'),
                },
            };
        },
        renderCall(args, theme) {
            return makeRenderer((width) => [truncateToWidth(renderCallLine(args, theme), width)]);
        },
        renderResult(result, opts, theme) {
            if (opts.isPartial) {
                const prog = theme?.fg('warning', '… editing') ?? '… editing';
                return makeRenderer(() => [prog]);
            }
            const ok = !result.isError;
            const details = result.details;
            const count = typeof details?.replacements === 'number'
                ? ` · ${details.replacements} replacement${details.replacements === 1 ? '' : 's'}`
                : '';
            const icon = theme?.fg(ok ? 'success' : 'error', ok ? '✓' : '✗') ?? (ok ? '✓' : '✗');
            const titleStr = theme?.fg('toolTitle', 'edit') ?? 'edit';
            const header = `${icon} ${titleStr}${count}`;
            const items = [{ text: header, truncate: true }];
            for (const file of details?.files ?? []) {
                items.push({
                    text: theme?.fg('accent', `  ${file.path}`) ?? `  ${file.path}`,
                    truncate: true,
                });
                for (const edit of file.edits ?? []) {
                    const range = edit.startLine === edit.endLine
                        ? `line ${edit.startLine}`
                        : `lines ${edit.startLine}–${edit.endLine}`;
                    // Meta: short summary line, safe to truncate
                    const metaStr = `    edit #${edit.editIndex + 1} · ${range} · ${edit.mode}`;
                    items.push({ text: theme?.fg('dim', metaStr) ?? metaStr, truncate: true });
                    // Reasoning: word-wrapped across multiple lines so the full text is
                    // always visible without any single line exceeding the terminal width
                    // (pi crashes with uncaughtException if a rendered line is too wide).
                    const reasonText = edit.reasoning.trim();
                    if (reasonText) {
                        const indent = '      '; // 6 spaces
                        items.push({
                            fn: (w) => {
                                const availWidth = Math.max(w - indent.length, 10);
                                return wrapText(reasonText, availWidth).map((line) => truncateToWidth(`${indent}${theme?.fg('muted', line) ?? line}`, w));
                            },
                        });
                    }
                    // Diff: Myers line diff between old and new so unchanged lines are skipped.
                    // Verbatim removedLines/addedLines showed identical -/+ pairs when new
                    // content was appended after an unchanged anchor block (confusing UX).
                    const ops = diffOps(edit.removedLines.join('\n'), edit.addedLines.join('\n'));
                    for (const op of ops) {
                        if (op.type === 'same')
                            continue;
                        const label = op.type === 'remove' ? '- ' : '+ ';
                        const color = op.type === 'remove' ? 'error' : 'success';
                        // 4-space indent is OUTSIDE theme.fg so the coloured substring
                        // `<color>- text</color>` is preserved for test assertions and renderers
                        // that match on the coloured part only.
                        const colored = theme?.fg(color, `${label}${op.line}`) ?? `${label}${op.line}`;
                        items.push({ text: `    ${colored}`, truncate: true });
                    }
                }
            }
            return makeRenderer((width) => items.flatMap((item) => 'fn' in item
                ? item.fn(width)
                : [item.truncate ? truncateToWidth(item.text, width) : item.text]));
        },
    });
}
