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
import { displayStatus, getPlanRfc, getPlanDecisions, planPhaseIndex, PLAN_PHASES, type DisplayStatus, type PlanStep, type PlanDecision } from './active-plan.js';
import { escapeHtml, renderOctocodePage } from '../tui/html-page.js';
import { renderMarkdown } from '../tui/markdown.js';

const REFRESH_SECONDS = 3;

// ─── Accepted RFC embed ───────────────────────────────────────────────────────

export interface RfcDoc {
  /** Absolute path to the RFC.md the plan derives from. */
  path: string;
  /** Raw RFC markdown (empty when `missing`). */
  markdown: string;
  /** The RFC's `Status:` header value, when present (Draft/In Review/Accepted/…). */
  status?: string;
  /** The linked RFC file could not be read (deleted/moved after linking). */
  missing?: boolean;
}

/** Value of a plain-text `Field: value` header line near the top of an RFC. */
function rfcHeaderField(markdown: string, field: string): string | undefined {
  const m = markdown.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'mi'));
  return m ? m[1] : undefined;
}

/**
 * Read the RFC linked to a plan scope FRESH from disk (so an open plan page picks
 * up RFC edits on the next mutation/refresh). Returns undefined when no RFC is
 * linked, and a `missing` doc when the linked file can no longer be read.
 */
export function readRfcDoc(scope: string): RfcDoc | undefined {
  const rfcPath = getPlanRfc(scope);
  if (!rfcPath) return undefined;
  try {
    const markdown = fs.readFileSync(rfcPath, 'utf8');
    return { path: rfcPath, markdown, status: rfcHeaderField(markdown, 'Status') };
  } catch {
    return { path: rfcPath, markdown: '', missing: true };
  }
}

const MD_MARK: Record<DisplayStatus, string> = {
  done: '- [x]',
  doing: '- [ ] ▸',
  todo: '- [ ]',
  blocked: '- [ ] ⊘',
};

const FLOW_GATES = [
  'Research current code and contracts with Octocode tools.',
  'For consequential work, write/update the RFC or implementation plan.',
  'Discuss the plan with the user; incorporate missing points and wait for approval.',
  'Derive local plan steps and Awareness tasks from the accepted document.',
  'Verify with the command/check named by the accepted plan.',
];

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
  // Mirror the TUI panel's color meaning so the browser diagram and terminal agree:
  // doing = teal (active/in-flight), todo = neutral, blocked = GOLD act-on-me (dashed),
  // done = muted. Previously doing was gold and blocked was gray — which inverted the
  // panel, where gold means "blocked, act on me".
  lines.push('  classDef done fill:#161B22,stroke:#30363D,color:#8B949E');
  lines.push('  classDef doing fill:#161B22,stroke:#5EEAD4,color:#5EEAD4');
  lines.push('  classDef todo fill:#161B22,stroke:#30363D,color:#C9D1D9');
  lines.push('  classDef blocked fill:#161B22,stroke:#F2C14E,color:#F2C14E,stroke-dasharray:4');
  return lines.join('\n');
}

export interface PlanMarkdownOptions {
  workspace?: string;
  status?: 'draft' | 'approved' | 'active';
  generatedAt?: Date;
  /** The accepted RFC this plan derives from — linked (not duplicated) in plan.md. */
  rfc?: RfcDoc;
  /** The clarify-phase decision log, rendered as a Decisions section. */
  decisions?: PlanDecision[];
}

/** A one-line RFC pointer for plan.md meta (link + status, or a not-found note). */
function rfcMdMeta(rfc: RfcDoc): string {
  if (rfc.missing) return `RFC: ${rfc.path} (linked file not found)`;
  return `RFC: ${rfc.path}${rfc.status ? ` (Status: ${rfc.status})` : ''}`;
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
    opts.rfc ? rfcMdMeta(opts.rfc) : undefined,
    `Generated: ${(opts.generatedAt ?? new Date()).toISOString()}`,
  ].filter(Boolean) as string[];
  const decisionsBlock = opts.decisions && opts.decisions.length
    ? ['## Decisions', ...opts.decisions.map((d) => `- **${d.q}** — ${d.a}`), '']
    : [];
  return [
    '# Octocode plan',
    '',
    ...meta,
    `Progress: ${done}/${steps.length} done`,
    '',
    '## Flow gates',
    ...FLOW_GATES.map((gate, i) => `${i + 1}. ${gate}`),
    '',
    ...decisionsBlock,
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

/**
 * The RFC section: the rendered RFC document (sanitized) as the plan page's lead,
 * so the surface the user reviews IS the accepted RFC. Empty string when no RFC is
 * linked; a short note when the linked file has gone missing.
 */
function rfcSectionHtml(rfc: RfcDoc | undefined): string {
  if (!rfc) return '';
  if (rfc.missing) {
    return `<section class="rfc"><h2>RFC</h2><div class="sub">Linked RFC not found: ${escapeHtml(rfc.path)}</div></section>`;
  }
  const badge = rfc.status ? ` <span class="rfc-status">${escapeHtml(rfc.status)}</span>` : '';
  return [
    `<section class="rfc"><h2>RFC${badge}</h2>`,
    `<div class="rfc-body">${renderMarkdown(rfc.markdown)}</div>`,
    `<div class="sub">Source: ${escapeHtml(rfc.path)}</div>`,
    '</section>',
  ].join('\n');
}

/** The horizontal phase timeline — where the plan is in the flow (done ✓ / now ▸ / upcoming ○). */
function phaseTimelineHtml(steps: PlanStep[]): string {
  const cur = planPhaseIndex(steps);
  const items = PLAN_PHASES.map((label, i) => {
    const cls = i < cur ? 'done' : i === cur ? 'now' : 'todo';
    const glyph = i < cur ? '✓' : i === cur ? '▸' : '○';
    return `<li class="ph ${cls}"><span class="ph-g">${glyph}</span>${escapeHtml(label)}</li>`;
  });
  return `<section class="timeline"><h2>Flow</h2><ol class="phase-timeline">${items.join('')}</ol></section>`;
}

/** The Decisions section — the clarify-phase interview answers that shaped the plan. Empty when none. */
function decisionsSectionHtml(decisions: PlanDecision[] | undefined): string {
  if (!decisions || decisions.length === 0) return '';
  const rows = decisions.map((d) => `<li><span class="dq">${escapeHtml(d.q)}</span><span class="da">${escapeHtml(d.a)}</span></li>`);
  return `<section><h2>Decisions</h2><ul class="decisions">${rows.join('')}</ul></section>`;
}

/** The plan page body (phase timeline + RFC + decisions + checklist + diagram + raw markdown). */
export function buildPlanPageHtml(steps: PlanStep[], rfc?: RfcDoc, decisions?: PlanDecision[]): string {
  const done = steps.filter((s) => s.status === 'done').length;
  const glyph: Record<DisplayStatus, string> = { done: '✓', doing: '▸', todo: '○', blocked: '⊘' };
  const items = steps.map((step, i) => {
    const ds = displayStatus(step, steps);
    const deps = ds === 'blocked' && step.dependsOn?.length
      ? ` <span class="deps">(needs ${step.dependsOn.map(String).map(escapeHtml).join(', ')})</span>`
      : '';
    return `<li class="${ds}"><span class="glyph">${glyph[ds]}</span>${i + 1}. ${escapeHtml(step.text)}${deps}</li>`;
  });
  const gates = FLOW_GATES.map((gate, i) => `<li>${i + 1}. ${escapeHtml(gate)}</li>`);
  return [
    // Phase timeline up top: where the plan sits in the flow at a glance.
    phaseTimelineHtml(steps),
    // RFC next: the plan the user reviews leads with the accepted decision doc,
    // then the interview decisions, the derived checklist, and dependency flow.
    rfcSectionHtml(rfc),
    decisionsSectionHtml(decisions),
    // ul.steps (not ol): the stylesheet only resets list-style on ul.steps, so an
    // ol here would stack a browser decimal marker on top of the manual "1." prefix.
    '<section><h2>Flow gates</h2><ul class="steps gates">',
    ...gates,
    '</ul></section>',
    `<section><h2>Steps · ${done}/${steps.length} done</h2><ul class="steps">`,
    ...items,
    '</ul></section>',
    '<section><h2>Dependency flow</h2>',
    `<pre class="mermaid">${escapeHtml(buildPlanMermaid(steps))}</pre>`,
    '<div class="sub">Diagram needs network once (mermaid CDN); the checklist above always renders.</div>',
    '</section>',
    `<details><summary>Raw markdown (.octocode/plan.md)</summary><pre>${escapeHtml(buildPlanMarkdown(steps, rfc ? { rfc } : {}))}</pre></details>`,
  ].filter(Boolean).join('\n');
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
    // Read the linked RFC + decision log fresh each write so an open plan page
    // tracks RFC/decision edits too (via the same meta-refresh as step changes).
    const rfc = readRfcDoc(scope);
    const decisions = getPlanDecisions(scope);
    const dir = planArtifactsDir(scope);
    fs.mkdirSync(dir, { recursive: true });
    const htmlPath = path.join(dir, 'plan.html');
    const mdPath = path.join(dir, 'plan.md');
    fs.writeFileSync(
      htmlPath,
      renderOctocodePage({
        title: 'Octocode plan',
        bodyHtml: buildPlanPageHtml(steps, rfc, decisions),
        refreshSeconds: REFRESH_SECONDS,
        mermaid: true,
      }),
      'utf8',
    );
    fs.writeFileSync(mdPath, buildPlanMarkdown(steps, { ...opts, ...(rfc ? { rfc } : {}), ...(decisions.length ? { decisions } : {}) }), 'utf8');
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
  if (liveSyncScope === undefined) return;
  // Preserve the metadata the served page was written with (status 'active' +
  // workspace) — passing no opts would regenerate plan.md with the default status
  // and DROP the Workspace line on every mutation, diverging from the served doc.
  const workspace = liveSyncScope.split('\0')[0] || liveSyncScope;
  writePlanArtifacts(liveSyncScope, steps, { status: 'active', workspace });
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
