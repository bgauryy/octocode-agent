/**
 * plan-html — the plan's local HTML/Markdown surface.
 *
 * `/octocode-plan html` (and now `plan(propose)`) writes `plan.html` (branded
 * page: status checklist + mermaid dependency diagram + raw markdown) and
 * `plan.md` (shareable) under the global Octocode home
 * (`~/.octocode/tmp/plan/<scope-hash>/`), opens the page, and arms LIVE SYNC:
 * every subsequent plan mutation rewrites both files, and the page's
 * meta-refresh picks the change up — so the user discusses in the terminal
 * while the browser shows the evolving plan. Keying by scope hash keeps parallel
 * sessions/repos from clobbering one another in the shared home dir. First rider
 * on the shared html-page shell; diff previews and worker timelines are designed
 * to reuse the same base.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getOctocodeHome } from '../env.js';
import { displayStatus, type DisplayStatus, type PlanStep } from './active-plan.js';
import { escapeHtml, renderOctocodePage } from '../tui/html-page.js';

const REFRESH_SECONDS = 3;

const MD_MARK: Record<DisplayStatus, string> = {
  done: '- [x]',
  doing: '- [ ] ▸',
  todo: '- [ ]',
  blocked: '- [ ] ⊘',
};

/** Escape a label for a quoted mermaid node: `S1["…"]`. */
function mermaidLabel(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/[\n\r]+/g, ' ');
}

/** Mermaid flowchart of the plan: one node per step, edges from dependsOn. */
export function buildPlanMermaid(steps: PlanStep[]): string {
  const lines = ['flowchart TD'];
  steps.forEach((step, i) => {
    const id = `S${i + 1}`;
    lines.push(`  ${id}["${i + 1}. ${mermaidLabel(step.text)}"]:::${displayStatus(step, steps)}`);
  });
  steps.forEach((step, i) => {
    for (const dep of step.dependsOn ?? []) {
      if (dep >= 1 && dep <= steps.length) lines.push(`  S${dep} --> S${i + 1}`);
    }
  });
  // Status palette mirrors the TUI panel: doing gold, todo teal, done muted.
  lines.push('  classDef done fill:#161B22,stroke:#30363D,color:#8B949E');
  lines.push('  classDef doing fill:#161B22,stroke:#F2C14E,color:#F2C14E');
  lines.push('  classDef todo fill:#161B22,stroke:#5EEAD4,color:#C9D1D9');
  lines.push('  classDef blocked fill:#161B22,stroke:#8B949E,color:#8B949E,stroke-dasharray:4');
  return lines.join('\n');
}

export interface PlanMarkdownOptions {
  workspace?: string;
  status?: 'draft' | 'approved' | 'active';
  generatedAt?: Date;
}

/** Shareable markdown: checklist + the mermaid source in a fence. */
export function buildPlanMarkdown(steps: PlanStep[], opts: PlanMarkdownOptions = {}): string {
  const done = steps.filter((s) => s.status === 'done').length;
  const rows = steps.map((step, i) => {
    const ds = displayStatus(step, steps);
    const deps = ds === 'blocked' && step.dependsOn?.length ? ` _(needs ${step.dependsOn.join(', ')})_` : '';
    const doing = ds === 'doing' ? ' _(in progress)_' : '';
    return `${MD_MARK[ds]} ${i + 1}. ${step.text}${doing}${deps}`;
  });
  const meta = [
    `Status: ${opts.status ?? 'active'}`,
    opts.workspace ? `Workspace: ${opts.workspace}` : undefined,
    `Generated: ${(opts.generatedAt ?? new Date()).toISOString()}`,
  ].filter(Boolean) as string[];
  return [
    '# Octocode plan',
    '',
    ...meta,
    `Progress: ${done}/${steps.length} done`,
    '',
    '<!-- OCTOCODE_PLAN_CHECKLIST_START -->',
    ...rows,
    '<!-- OCTOCODE_PLAN_CHECKLIST_END -->',
    '',
    '```mermaid',
    buildPlanMermaid(steps),
    '```',
    '',
  ].join('\n');
}

/** The plan page body (checklist section + diagram section + raw markdown). */
export function buildPlanPageHtml(steps: PlanStep[]): string {
  const done = steps.filter((s) => s.status === 'done').length;
  const glyph: Record<DisplayStatus, string> = { done: '✓', doing: '▸', todo: '○', blocked: '⊘' };
  const items = steps.map((step, i) => {
    const ds = displayStatus(step, steps);
    const deps = ds === 'blocked' && step.dependsOn?.length
      ? ` <span class="deps">(needs ${step.dependsOn.map(String).map(escapeHtml).join(', ')})</span>`
      : '';
    return `<li class="${ds}"><span class="glyph">${glyph[ds]}</span>${i + 1}. ${escapeHtml(step.text)}${deps}</li>`;
  });
  return [
    `<section><h2>Steps · ${done}/${steps.length} done</h2><ul class="steps">`,
    ...items,
    '</ul></section>',
    '<section><h2>Dependency flow</h2>',
    `<pre class="mermaid">${escapeHtml(buildPlanMermaid(steps))}</pre>`,
    '<div class="sub">Diagram needs network once (mermaid CDN); the checklist above always renders.</div>',
    '</section>',
    `<details><summary>Raw markdown (.octocode/plan.md)</summary><pre>${escapeHtml(buildPlanMarkdown(steps))}</pre></details>`,
  ].join('\n');
}

export interface PlanArtifactOptions extends PlanMarkdownOptions {}

export interface PlanArtifacts {
  htmlPath: string;
  mdPath: string;
}

/**
 * Directory for a plan scope's HTML/MD under the global Octocode home:
 * `~/.octocode/tmp/plan/<scope-hash>/`. Keyed by the same scope string the
 * plan JSON uses, so a session's page is one predictable place and parallel
 * scopes never share a file.
 */
export function planArtifactsDir(scope: string): string {
  const hash = createHash('sha256').update(scope || 'default').digest('hex').slice(0, 16);
  return path.join(getOctocodeHome(), 'tmp', 'plan', hash);
}

/** Write plan.html + plan.md under `~/.octocode/tmp/plan/<scope-hash>/`. Never throws. */
export function writePlanArtifacts(scope: string, steps: PlanStep[], opts: PlanArtifactOptions = {}): PlanArtifacts | undefined {
  try {
    const dir = planArtifactsDir(scope);
    fs.mkdirSync(dir, { recursive: true });
    const htmlPath = path.join(dir, 'plan.html');
    const mdPath = path.join(dir, 'plan.md');
    fs.writeFileSync(
      htmlPath,
      renderOctocodePage({
        title: 'Octocode plan',
        bodyHtml: buildPlanPageHtml(steps),
        refreshSeconds: REFRESH_SECONDS,
        mermaid: true,
      }),
      'utf8',
    );
    fs.writeFileSync(mdPath, buildPlanMarkdown(steps, opts), 'utf8');
    return { htmlPath, mdPath };
  } catch {
    return undefined; // Best-effort surface — a write failure must never break the plan tool.
  }
}

// ─── Live sync ────────────────────────────────────────────────────────────────

/**
 * Scope the user opened the page for; mutations rewrite the files while set.
 * One active scope per process: arming a new scope replaces the previous one
 * (the plan tool is single-scope per session). Cleared by resetPlanHtmlSync on
 * plan clear (see plan-tool tearDownPlanHtml).
 */
let liveSyncScope: string | undefined;

export function enablePlanHtmlSync(scope: string): void {
  liveSyncScope = scope;
}

export function resetPlanHtmlSync(): void {
  liveSyncScope = undefined;
}

/** Rewrite the artifacts when live sync is armed (called on every plan refresh). */
export function syncPlanHtmlIfEnabled(steps: PlanStep[]): void {
  if (liveSyncScope !== undefined) writePlanArtifacts(liveSyncScope, steps);
}

// ─── Opening ──────────────────────────────────────────────────────────────────

export interface PlanOpenResult {
  ok: boolean;
  message?: string;
}

type Opener = (target: string) => PlanOpenResult;

const defaultOpener: Opener = (target) => {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', target] : [target];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `Could not open plan page automatically: ${(error as Error).message}. Open ${target} manually.` };
  }
};

let opener: Opener = defaultOpener;

export function setPlanOpenerForTests(next: Opener | undefined): void {
  opener = next ?? defaultOpener;
}

export function openPlanHtml(htmlPath: string): PlanOpenResult {
  return opener(htmlPath);
}
