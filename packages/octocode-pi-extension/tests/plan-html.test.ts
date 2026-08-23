/**
 * Tests for the plan's local HTML/Markdown surface — pure builders (mermaid,
 * markdown, page body), artifact writing, and the live-sync toggle.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import {
  buildPlanMermaid,
  buildPlanMarkdown,
  buildPlanPageHtml,
  writePlanArtifacts,
  enablePlanHtmlSync,
  resetPlanHtmlSync,
  syncPlanHtmlIfEnabled,
  openPlanHtml,
  setPlanOpenerForTests,
  type RfcDoc,
} from '../src/tools/plan-html.js';
import { setPlan, setPlanRfc, setPlanDecisions, getPlan, clearPlan, type PlanStep } from '../src/tools/active-plan.js';

const ORIGINAL_HOME = process.env['OCTOCODE_HOME'];
afterEach(() => {
  resetPlanHtmlSync();
  setPlanOpenerForTests(undefined);
  if (ORIGINAL_HOME === undefined) delete process.env['OCTOCODE_HOME'];
  else process.env['OCTOCODE_HOME'] = ORIGINAL_HOME;
});

const STEPS: PlanStep[] = [
  { text: 'Design schema', status: 'done' },
  { text: 'Build "core" <module>', status: 'doing' },
  { text: 'Ship it', status: 'todo', dependsOn: [1, 2] },
];

test('buildPlanMermaid draws status-classed nodes and dependency edges', () => {
  const m = buildPlanMermaid(STEPS);
  assert.match(m, /^flowchart TD/);
  assert.match(m, /S1\["1\. Design schema"\]:::done/);
  assert.match(m, /S2\[.*:::doing/);
  assert.match(m, /S3\[.*:::blocked/, 'unmet deps render as blocked');
  assert.match(m, /S1 --> S3/);
  assert.match(m, /S2 --> S3/);
  assert.match(m, /#quot;core#quot;/, 'quotes escaped for mermaid labels');
});

test('buildPlanMarkdown renders flow gates, progress, checkboxes, and the mermaid fence', () => {
  const md = buildPlanMarkdown(STEPS);
  assert.match(md, /Status: active/);
  assert.match(md, /Generated: \d{4}-\d{2}-\d{2}T/);
  assert.match(md, /Progress: 1\/3 done/);
  assert.match(md, /## Flow gates/);
  assert.match(md, /Research current code and contracts with Octocode tools/);
  assert.match(md, /Discuss the plan with the user; incorporate missing points and wait for approval/);
  assert.match(md, /Derive local plan steps and Awareness tasks from the accepted document/);
  assert.match(md, /OCTOCODE_PLAN_CHECKLIST_START/);
  assert.match(md, /- \[x\] 1\. Design schema/);
  assert.match(md, /- \[ \] ▸ 2\..*_\(in progress\)_/);
  assert.match(md, /- \[ \] ⊘ 3\. Ship it.*needs 1, 2/);
  assert.match(md, /```mermaid\nflowchart TD/);
});

test('buildPlanPageHtml escapes dynamic checklist text and embeds the diagram', () => {
  const html = buildPlanPageHtml([
    { text: 'Design schema', status: 'todo', dependsOn: [3, '<script>'] as unknown as number[] },
    ...STEPS,
  ]);
  assert.match(html, /&lt;module&gt;/, 'HTML in step text is escaped');
  assert.doesNotMatch(html, /<module>/);
  assert.match(html, /needs 3, &lt;script&gt;/, 'dependency labels are escaped');
  assert.doesNotMatch(html, /needs 3, <script>/);
  assert.match(html, /<section><h2>Flow gates<\/h2>/);
  assert.match(html, /Discuss the plan with the user; incorporate missing points and wait for approval/);
  assert.match(html, /<pre class="mermaid">/);
  assert.match(html, /1\/4 done/);
});

// ─── RFC embed (plan page = RFC) ──────────────────────────────────────────────

const RFC_MD = [
  '# RFC: Unify plan and RFC',
  '',
  'Status: Accepted',
  '',
  '## Summary',
  'Embed the RFC in the plan page and <b>render</b> it, ignoring <script>alert(1)</script>.',
  '',
  '| Option | Verdict |',
  '|---|---|',
  '| Unify | chosen |',
  '',
].join('\n');

test('buildPlanPageHtml renders a linked RFC as the lead section, sanitized, with a status badge', () => {
  const rfc: RfcDoc = { path: '/ws/.octocode/rfc/unify/RFC.md', markdown: RFC_MD, status: 'Accepted' };
  const html = buildPlanPageHtml(STEPS, rfc);
  // RFC section leads the page (before Flow gates).
  assert.ok(html.indexOf('section class="rfc"') < html.indexOf('<h2>Flow gates</h2>'), 'RFC section comes first');
  assert.match(html, /rfc-status">Accepted</, 'status badge shown');
  assert.match(html, /<h2>Summary<\/h2>/, 'RFC markdown headings are rendered');
  assert.match(html, /<table>/, 'RFC tables render');
  assert.doesNotMatch(html, /<script>alert/, 'raw script in the RFC is neutralized');
  assert.match(html, /&lt;script&gt;alert/, 'the script is escaped as text');
  assert.doesNotMatch(html, /<b>render<\/b>/, 'inline raw HTML is neutralized too');
  assert.match(html, /Source: \/ws\/\.octocode\/rfc\/unify\/RFC\.md/);
});

test('buildPlanPageHtml notes a missing linked RFC instead of failing', () => {
  const html = buildPlanPageHtml(STEPS, { path: '/ws/.octocode/rfc/x/RFC.md', markdown: '', missing: true });
  assert.match(html, /Linked RFC not found: \/ws\/\.octocode\/rfc\/x\/RFC\.md/);
});

test('buildPlanPageHtml without an RFC is unchanged (no rfc section)', () => {
  const html = buildPlanPageHtml(STEPS);
  assert.doesNotMatch(html, /section class="rfc"/);
});

test('buildPlanMarkdown adds an RFC pointer line (link + status), not a duplicate of the RFC', () => {
  const md = buildPlanMarkdown(STEPS, { rfc: { path: '/p/.octocode/rfc/x/RFC.md', markdown: RFC_MD, status: 'Accepted' } });
  assert.match(md, /RFC: \/p\/\.octocode\/rfc\/x\/RFC\.md \(Status: Accepted\)/);
});

test('writePlanArtifacts embeds the linked RFC and live-sync re-reads it fresh', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-home-'));
  process.env['OCTOCODE_HOME'] = home;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rfc-embed-ws-'));
  const rfcDir = path.join(ws, '.octocode', 'rfc', 'unify');
  fs.mkdirSync(rfcDir, { recursive: true });
  const rfcFile = path.join(rfcDir, 'RFC.md');
  fs.writeFileSync(rfcFile, RFC_MD);
  const scope = ws;
  try {
    setPlan(scope, ['do the work']);
    setPlanRfc(scope, rfcFile);
    const art = writePlanArtifacts(scope, getPlan(scope), { status: 'active', workspace: ws })!;
    const page = fs.readFileSync(art.htmlPath, 'utf8');
    assert.match(page, /section class="rfc"/, 'linked RFC is embedded in the page');
    assert.match(page, /Embed the RFC in the plan page/, 'RFC summary text is rendered');
    const md = fs.readFileSync(art.mdPath, 'utf8');
    assert.match(md, new RegExp(`RFC: ${rfcFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(Status: Accepted\\)`));

    // Live sync: edit the RFC on disk, then a plan mutation refresh must pick it up.
    fs.writeFileSync(rfcFile, RFC_MD + '\n\nUPDATED_RFC_MARKER\n');
    enablePlanHtmlSync(scope);
    syncPlanHtmlIfEnabled(getPlan(scope));
    assert.match(fs.readFileSync(art.htmlPath, 'utf8'), /UPDATED_RFC_MARKER/, 'the open page reflects fresh RFC edits');
  } finally {
    clearPlan(scope);
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ─── Phase timeline + decisions ───────────────────────────────────────────────

test('buildPlanPageHtml renders the phase timeline with the current phase marked', () => {
  // A step in flight → Build is current; Research/RFC/Approve read as done.
  const html = buildPlanPageHtml([{ text: 'a', status: 'doing' }, { text: 'b', status: 'todo' }]);
  assert.match(html, /class="phase-timeline"/);
  assert.match(html, /class="ph now"><span class="ph-g">▸<\/span>Build/);
  assert.match(html, /class="ph done"><span class="ph-g">✓<\/span>Research/);
  assert.match(html, /class="ph todo"><span class="ph-g">○<\/span>Verify/);
});

test('buildPlanPageHtml renders a Decisions section only when decisions are present', () => {
  const none = buildPlanPageHtml(STEPS);
  assert.doesNotMatch(none, /<h2>Decisions<\/h2>/);
  const withD = buildPlanPageHtml(STEPS, undefined, [{ q: 'Storage?', a: 'SQLite' }, { q: 'Auth?', a: 'Reuse' }]);
  assert.match(withD, /<h2>Decisions<\/h2>/);
  assert.match(withD, /class="dq">Storage\?<\/span><span class="da">SQLite/);
});

test('buildPlanMarkdown renders a ## Decisions block when present', () => {
  const md = buildPlanMarkdown(STEPS, { decisions: [{ q: 'Storage?', a: 'SQLite' }] });
  assert.match(md, /## Decisions/);
  assert.match(md, /- \*\*Storage\?\*\* — SQLite/);
});

test('writePlanArtifacts embeds the plan decision log', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-home-'));
  process.env['OCTOCODE_HOME'] = home;
  const scope = '/dec/workspace';
  try {
    setPlan(scope, ['do it']);
    setPlanDecisions(scope, [{ q: 'Which backend?', a: 'SQLite (chosen)' }]);
    const art = writePlanArtifacts(scope, getPlan(scope), { status: 'active' })!;
    assert.match(fs.readFileSync(art.htmlPath, 'utf8'), /<h2>Decisions<\/h2>/);
    assert.match(fs.readFileSync(art.htmlPath, 'utf8'), /Which backend\?/);
    assert.match(fs.readFileSync(art.mdPath, 'utf8'), /## Decisions/);
  } finally {
    clearPlan(scope);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('openPlanHtml returns a user-visible fallback when the browser opener fails', () => {
  setPlanOpenerForTests((target) => ({ ok: false, message: `Could not open ${target}` }));
  const result = openPlanHtml('http://127.0.0.1:1234/plan/');
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /Could not open/);
  assert.match(result.message ?? '', /127\.0\.0\.1/);
});

test('writePlanArtifacts writes html + md under the octocode home; live sync rewrites on change', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-home-'));
  process.env['OCTOCODE_HOME'] = home;
  const scope = '/some/workspace\0/tmp/session-abc';
  const artifacts = writePlanArtifacts(scope, STEPS, { status: 'draft', workspace: '/some/workspace', generatedAt: new Date('2026-01-02T03:04:05.000Z') })!;
  assert.ok(fs.existsSync(artifacts.htmlPath));
  assert.ok(fs.existsSync(artifacts.mdPath));
  // Artifacts live under ~/.octocode/tmp/plan/<scope-hash>/, not the cwd.
  assert.ok(artifacts.htmlPath.startsWith(path.join(home, 'tmp', 'plan')), 'html lives under the home tmp/plan dir');
  const page = fs.readFileSync(artifacts.htmlPath, 'utf8');
  assert.match(page, /<!doctype html>/);
  assert.match(page, /http-equiv="refresh"/, 'page auto-refreshes for live updates');
  assert.match(page, /cdn\.jsdelivr\.net\/npm\/mermaid/);
  const md = fs.readFileSync(artifacts.mdPath, 'utf8');
  assert.match(md, /Status: draft/);
  assert.match(md, /Workspace: \/some\/workspace/);
  assert.match(md, /Generated: 2026-01-02T03:04:05\.000Z/);

  // Distinct scopes never share a file.
  const other = writePlanArtifacts('/other/scope', STEPS)!;
  assert.notEqual(path.dirname(other.htmlPath), path.dirname(artifacts.htmlPath));

  // Live sync: disabled → no rewrite; enabled → rewrite reflects new state.
  fs.rmSync(artifacts.htmlPath);
  syncPlanHtmlIfEnabled(STEPS);
  assert.equal(fs.existsSync(artifacts.htmlPath), false, 'sync is a no-op until armed');
  enablePlanHtmlSync(scope);
  syncPlanHtmlIfEnabled([{ text: 'Only step', status: 'done' }]);
  assert.match(fs.readFileSync(artifacts.htmlPath, 'utf8'), /1\/1 done/);
});
