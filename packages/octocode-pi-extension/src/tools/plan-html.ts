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
import { createHash } from 'node:crypto';
import { getOctocodeHome } from '../env.js';
import { dependencyIndexes, displayStatus, getPlanRfc, getPlanDecisions, getPlanReviewState, planPhaseIndex, PLAN_PHASES, artifactContextForScope, type DisplayStatus, type PlanStep, type PlanDecision, type PlanPhase, type ReviewState } from './active-plan.js';
import { escapeHtml, renderOctocodePage } from '../tui/html-page.js';
import { renderMarkdown } from '../tui/markdown.js';
import { openLocalUrl } from './local-url-opener.js';

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
    for (const dep of dependencyIndexes(step, steps)) {
      lines.push(`  S${dep} --> S${i + 1}`);
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
  /** Persisted lifecycle phase; distinguishes Review, Accepted, and Execute. */
  phase?: PlanPhase;
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
    const dependencies = dependencyIndexes(step, steps);
    const deps = ds === 'blocked' && dependencies.length ? ` _(needs ${dependencies.join(', ')})_` : '';
    const doing = ds === 'doing' ? ' _(in progress)_' : '';
    return `${MD_MARK[ds]} ${i + 1}. ${step.text}${doing}${deps}`;
  });
  const meta = [
    `Status: ${opts.status ?? 'active'}`,
    opts.workspace ? `Workspace: ${opts.workspace}` : undefined,
    opts.rfc ? rfcMdMeta(opts.rfc) : undefined,
    opts.phase ? `Phase: ${opts.phase}` : undefined,
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
const REVIEW_PHASE_TIMELINE: ReadonlyArray<{ phase: Exclude<PlanPhase, 'abandoned'>; label: string }> = [
  { phase: 'researching', label: 'Research' },
  { phase: 'needs_answers', label: 'Clarify' },
  { phase: 'draft', label: 'Draft' },
  { phase: 'in_review', label: 'Review' },
  { phase: 'accepted', label: 'Accepted' },
  { phase: 'executing', label: 'Execute' },
  { phase: 'verifying', label: 'Verify' },
  { phase: 'complete', label: 'Complete' },
];

function phaseTimelineHtml(steps: PlanStep[], review?: ReviewState): string {
  const labels = review ? REVIEW_PHASE_TIMELINE.map((item) => item.label) : [...PLAN_PHASES];
  const cur = review
    ? review.phase === 'abandoned'
      ? -1
      : Math.max(0, REVIEW_PHASE_TIMELINE.findIndex((item) => item.phase === review.phase))
    : planPhaseIndex(steps);
  const items = labels.map((label, i) => {
    const cls = i < cur ? 'done' : i === cur ? 'now' : 'todo';
    const glyph = i < cur ? '✓' : i === cur ? '▸' : '○';
    return `<li class="ph ${cls}"><span class="ph-g">${glyph}</span>${escapeHtml(label)}</li>`;
  });
  const note = review?.phase === 'abandoned'
    ? '<p class="phase-note abandoned">This plan was abandoned.</p>'
    : review
      ? `<p class="phase-note">Current state: <strong>${escapeHtml(review.phase.replace(/_/g, ' '))}</strong></p>`
      : '';
  return `<section class="timeline"><h2>Flow</h2><ol class="phase-timeline">${items.join('')}</ol>${note}</section>`;
}

/** The Decisions section — the clarify-phase interview answers that shaped the plan. Empty when none. */
function decisionsSectionHtml(decisions: PlanDecision[] | undefined): string {
  if (!decisions || decisions.length === 0) return '';
  const rows = decisions.map((d) => `<li><span class="dq">${escapeHtml(d.q)}</span><span class="da">${escapeHtml(d.a)}</span></li>`);
  return `<section><h2>Decisions</h2><ul class="decisions">${rows.join('')}</ul></section>`;
}

/** Same-origin browser controls that feed review decisions back into the active agent task. */
function browserReplySectionHtml(review?: ReviewState): string {
  const revision = review?.revision ?? review?.acceptedRevision;
  const contextualActions = review?.phase === 'in_review' && revision
    ? `<button type="button" data-reply-command="/octocode-plan accept ${escapeHtml(revision)}" class="primary">Approve revision · ${escapeHtml(revision.slice(0, 8))}</button>
    <button type="button" data-reply-command="/octocode-plan changes">Request changes</button>`
    : review?.phase === 'accepted'
      ? '<button type="button" data-reply-command="/octocode-plan start" class="primary">Start implementation</button>\n    <button type="button" data-reply-command="/octocode-plan changes">Reopen review</button>'
      : '';
  const help = review?.phase === 'in_review'
    ? 'Approve the exact displayed revision, request changes, or send a note. Approval keeps implementation blocked.'
    : review?.phase === 'accepted'
      ? 'The design is accepted. Start is the separate action that enables implementation.'
      : 'Send a note directly to the running agent task.';
  return `<section class="browser-reply" data-browser-reply>
  <h2>Reply to the agent</h2>
  <p class="reply-help">${escapeHtml(help)}</p>
  <label for="octocode-reply">Feedback</label>
  <textarea id="octocode-reply" maxlength="8000" rows="4" placeholder="What should change, or what should the agent know?"></textarea>
  <div class="reply-actions">
    <button type="button" data-reply-action="send">Send feedback</button>
    ${contextualActions}
  </div>
  <p class="reply-status" role="status" aria-live="polite" aria-atomic="true"></p>
</section>
<script type="module">
(() => {
  const root = document.querySelector('[data-browser-reply]');
  if (!root) return;
  const input = root.querySelector('textarea');
  const status = root.querySelector('.reply-status');
  const storageKey = 'octocode-plan-reply';
  try { input.value = sessionStorage.getItem(storageKey) || ''; } catch {}
  input.addEventListener('input', () => { try { sessionStorage.setItem(storageKey, input.value); } catch {} });
  const send = async (button) => {
    const notes = input.value.trim();
    const command = button.dataset.replyCommand || '';
    const message = command
      ? command === '/octocode-plan changes' && notes ? command + ' ' + notes : command
      : notes;
    if (!message) { status.textContent = 'Write feedback before sending.'; input.focus(); return; }
    root.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    status.textContent = 'Sending…';
    try {
      const response = await fetch('__octocode/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) throw new Error(await response.text());
      input.value = '';
      try { sessionStorage.removeItem(storageKey); } catch {}
      status.textContent = 'Sent to the agent.';
    } catch (error) {
      status.textContent = 'Could not send: ' + (error instanceof Error ? error.message : String(error));
    } finally {
      root.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  };
  root.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => void send(button));
  });
})();
</script>`;
}

/** The plan page body (phase timeline + RFC + decisions + checklist + diagram + raw markdown). */
export function buildPlanPageHtml(steps: PlanStep[], rfc?: RfcDoc, decisions?: PlanDecision[], review?: ReviewState): string {
  const done = steps.filter((s) => s.status === 'done').length;
  const glyph: Record<DisplayStatus, string> = { done: '✓', doing: '▸', todo: '○', blocked: '⊘' };
  const items = steps.map((step, i) => {
    const ds = displayStatus(step, steps);
    const dependencies = dependencyIndexes(step, steps);
    const deps = ds === 'blocked' && dependencies.length
      ? ` <span class="deps">(needs ${dependencies.map(String).map(escapeHtml).join(', ')})</span>`
      : '';
    return `<li class="${ds}"><span class="glyph">${glyph[ds]}</span>${i + 1}. ${escapeHtml(step.text)}${deps}</li>`;
  });
  const gates = FLOW_GATES.map((gate, i) => `<li>${i + 1}. ${escapeHtml(gate)}</li>`);
  return [
    // Phase timeline up top: where the plan sits in the flow at a glance.
    phaseTimelineHtml(steps, review),
    // RFC next: the plan the user reviews leads with the accepted decision doc,
    // then the interview decisions, the derived checklist, and dependency flow.
    rfcSectionHtml(rfc),
    decisionsSectionHtml(decisions),
    browserReplySectionHtml(review),
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
    `<details><summary>Raw markdown (.octocode/plan.md)</summary><pre>${escapeHtml(buildPlanMarkdown(steps, { ...(rfc ? { rfc } : {}), ...(review ? { phase: review.phase } : {}) }))}</pre></details>`,
  ].filter(Boolean).join('\n');
}

export interface PlanArtifactOptions extends PlanMarkdownOptions {}

export interface PlanArtifacts {
  htmlPath: string;
  mdPath: string;
}

/**
 * Directory for a plan scope's HTML/MD.
 *
 * Primary: `<workspace>/.octocode/agent/<session-key>/plan/` — scoped to the
 * session artifact tree so all tool outputs land under one session root.
 * Fallback: `~/.octocode/tmp/plan/<scope-hash>/` — used when the workspace is
 * not yet initialised or the session artifact dir cannot be created.
 */
export function planArtifactsDir(scope: string): string {
  try {
    return artifactContextForScope(scope).resolve('plan');
  } catch {
    // Fallback: global home keyed by scope hash.
    const hash = createHash('sha256').update(scope || 'default').digest('hex').slice(0, 16);
    return path.join(getOctocodeHome(), 'tmp', 'plan', hash);
  }
}

/** Write plan.html + plan.md under the session artifact dir (fallback: `~/.octocode/tmp/plan/<hash>/`). Never throws. */
export function writePlanArtifacts(scope: string, steps: PlanStep[], opts: PlanArtifactOptions = {}): PlanArtifacts | undefined {
  try {
    // Read the linked RFC + decision log fresh each write so an open plan page
    // tracks RFC/decision edits too (via the same meta-refresh as step changes).
    const rfc = readRfcDoc(scope);
    const decisions = getPlanDecisions(scope);
    const review = getPlanReviewState(scope);
    // Create the artifact context ONCE — used for both dir resolution and manifest
    // registration so we pay the dir-walk + manifest lock overhead only one time.
    let artifactCtx: ReturnType<typeof artifactContextForScope> | undefined;
    let dir: string;
    try {
      artifactCtx = artifactContextForScope(scope);
      dir = artifactCtx.resolve('plan');
    } catch {
      // Fallback when workspace is not initialised or session context is absent.
      const hash = createHash('sha256').update(scope || 'default').digest('hex').slice(0, 16);
      dir = path.join(getOctocodeHome(), 'tmp', 'plan', hash);
    }
    fs.mkdirSync(dir, { recursive: true });
    const htmlPath = path.join(dir, 'plan.html');
    const mdPath = path.join(dir, 'plan.md');
    const html = renderOctocodePage({
      title: 'Octocode plan',
      bodyHtml: buildPlanPageHtml(steps, rfc, decisions, review),
      refreshSeconds: REFRESH_SECONDS,
      refreshToken: `${review.branchSnapshotId}:${review.generation}`,
      mermaid: true,
    });
    const markdown = buildPlanMarkdown(steps, { ...opts, phase: review.phase, ...(rfc ? { rfc } : {}), ...(decisions.length ? { decisions } : {}) });
    if (artifactCtx) {
      // Session artifacts use the shared atomic/private writer. The fallback
      // remains a best-effort global-home projection for pre-session hosts.
      artifactCtx.writeText('plan/plan.html', html);
      artifactCtx.writeText('plan/plan.md', markdown);
    } else {
      fs.writeFileSync(htmlPath, html, 'utf8');
      fs.writeFileSync(mdPath, markdown, 'utf8');
    }
    // Register both files in the session artifact manifest using the already-open context.
    if (artifactCtx) {
      try {
        artifactCtx.registerProducer('plan', 'plan/plan.html');
        artifactCtx.registerProducer('plan', 'plan/plan.md');
      } catch { /* best-effort — never break the plan tool */ }
    }
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

type Opener = (target: string) => PlanOpenResult | Promise<PlanOpenResult>;

const defaultOpener: Opener = async (target) => {
  const result = await openLocalUrl(target);
  return { ok: result.ok, message: result.message };
};

let opener: Opener = defaultOpener;

export function setPlanOpenerForTests(next: Opener | undefined): void {
  opener = next ?? defaultOpener;
}

export async function openPlanHtml(htmlPath: string): Promise<PlanOpenResult> {
  return opener(htmlPath);
}
