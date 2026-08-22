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
} from '../src/tools/plan-html.js';
import type { PlanStep } from '../src/tools/active-plan.js';

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

test('buildPlanMarkdown renders progress, checkboxes, and the mermaid fence', () => {
  const md = buildPlanMarkdown(STEPS);
  assert.match(md, /Status: active/);
  assert.match(md, /Generated: \d{4}-\d{2}-\d{2}T/);
  assert.match(md, /Progress: 1\/3 done/);
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
  assert.match(html, /<pre class="mermaid">/);
  assert.match(html, /1\/4 done/);
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
