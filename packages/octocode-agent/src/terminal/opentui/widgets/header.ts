import { OpenTuiWidget } from './base.js';
import type {
  WidgetRenderAdapter,
  WidgetRenderRegion,
  WidgetRenderState,
} from './contracts.js';
import { fitTerminalText, terminalDisplayWidth } from './layout.js';
import { sanitizeSingleLineText, segmentGraphemes } from './sanitize.js';
import {
  OCTOCODE_BETA_NOTICE,
  OCTOCODE_COMPACT_MARK,
  OCTOCODE_TAGLINE,
  renderOctocodeBannerLines,
} from '../branding/banner.js';

export type HeaderTrust = 'trusted' | 'untrusted' | 'unknown';
export type HeaderWorkingState = 'idle' | 'active' | 'cancelling' | 'failed';

/**
 * Canonical header data supplied by the launcher/runtime boundary. Agent-authored
 * prose is deliberately not an accepted authority.
 */
export interface HeaderSnapshot {
  readonly authority: 'runtime';
  readonly title: string;
  readonly sessionId?: string;
  readonly modelId?: string;
  readonly version?: string;
  readonly trust: HeaderTrust;
  readonly working: HeaderWorkingState;
  readonly width: number;
}

const MAX_IDENTITY_LENGTH = 512;
const MAX_VIEWPORT_WIDTH = 10_000;
const VALID_TRUST: ReadonlySet<string> = new Set(['trusted', 'untrusted', 'unknown']);
const VALID_WORKING: ReadonlySet<string> = new Set(['idle', 'active', 'cancelling', 'failed']);

const AGENT_INSTRUCTIONS = {
  purpose: 'Render the canonical runtime header as one stable, accessible terminal line.',
  useWhen: [
    'The launcher has canonical session, model, workspace-trust, and working-state data to summarize.',
    'A terminal or alternate-output consumer needs stable runtime identity without reading transcript prose.',
  ],
  avoidWhen: [
    'The only source is assistant-authored text, a tool result, or another untrusted display string.',
    'The content is a notification, prompt, transcript message, or progress update owned by another widget.',
  ],
  inputs: [
    'Accept only a snapshot carrying explicit runtime authority; never accept agent-authored identity or trust.',
    'Use the canonical launcher title, session ID, model ID, workspace trust, working state, and viewport width.',
  ],
  stateAndOutput: [
    'Render title, working state, trust, model, and session only; do not infer or decorate identity.',
    'Preserve trust and working state before model and session details when the terminal is narrow.',
    'Announce only material session, model, or trust changes; rendering, resizing, title, and working changes stay quiet.',
  ],
  keys: [
    'This read-only header is not focusable and accepts no direct keyboard or mouse input.',
  ],
  accessibility: [
    'Use explicit trust and working words; never rely on color, animation, or position alone.',
    'Truncate visible text only at grapheme boundaries and expose complete alternate plain text.',
    'Expose banner semantics so assistive output identifies the canonical terminal header.',
  ],
  recovery: [
    'Reject snapshots without runtime authority and never substitute agent-authored trust or identity.',
    'Strip terminal controls, collapse multiline values, and reject empty or over-bounded canonical fields.',
    'When width is insufficient, omit session then model before truncating higher-priority state.',
  ],
} as const;

function safeIdentity(value: string, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a bounded single-line value`);
  }
  const normalized = sanitizeSingleLineText(
    value.replace(/[\r\n\t\u2028\u2029]+/gu, ' '),
    { maxGraphemes: MAX_IDENTITY_LENGTH + 1, tabWidth: 1 },
  )
    .replace(/\s{2,}/gu, ' ')
    .trim();
  if (normalized.length === 0 || segmentGraphemes(normalized).length > MAX_IDENTITY_LENGTH) {
    throw new Error(`${label} must be a bounded single-line value`);
  }
  return normalized;
}

function normalizeSnapshot(snapshot: HeaderSnapshot): HeaderSnapshot {
  if (snapshot.authority !== 'runtime') {
    throw new Error('header identity and trust require runtime authority');
  }
  if (!Number.isSafeInteger(snapshot.width) || snapshot.width < 1 || snapshot.width > MAX_VIEWPORT_WIDTH) {
    throw new Error(`header width must be an integer from 1 to ${MAX_VIEWPORT_WIDTH}`);
  }
  if (!VALID_TRUST.has(snapshot.trust)) throw new Error('header trust is invalid');
  if (!VALID_WORKING.has(snapshot.working)) throw new Error('header working state is invalid');
  return Object.freeze({
    authority: 'runtime',
    title: safeIdentity(snapshot.title, 'header title'),
    ...(snapshot.sessionId === undefined
      ? {}
      : { sessionId: safeIdentity(snapshot.sessionId, 'session id') }),
    ...(snapshot.modelId === undefined
      ? {}
      : { modelId: safeIdentity(snapshot.modelId, 'model id') }),
    ...(snapshot.version === undefined
      ? {}
      : { version: safeIdentity(snapshot.version, 'version') }),
    trust: snapshot.trust,
    working: snapshot.working,
    width: snapshot.width,
  });
}

function sameSnapshot(left: HeaderSnapshot, right: HeaderSnapshot): boolean {
  return left.title === right.title
    && left.sessionId === right.sessionId
    && left.modelId === right.modelId
    && left.version === right.version
    && left.trust === right.trust
    && left.working === right.working
    && left.width === right.width;
}

function changedValue(value: string | undefined): string {
  return value ?? 'not available';
}

/** Read-only OpenTUI banner for runtime-owned identity and safety state. */
export class HeaderWidget extends OpenTuiWidget {
  private snapshot: HeaderSnapshot;
  private readonly announcements: string[] = [];

  constructor(id: string, initial: HeaderSnapshot) {
    super({
      id,
      kind: 'header',
      capabilities: { focusable: false, inputMode: 'none' },
      accessibility: {
        role: 'banner',
        label: 'Runtime header',
        description: 'Banner-like canonical session, model, trust, and working-state summary.',
        liveRegion: 'polite',
        keyboardHelp: ['Read only; move to the transcript or prompt for interactive content.'],
      },
      instructions: AGENT_INSTRUCTIONS,
    });
    this.snapshot = normalizeSnapshot(initial);
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  update(next: HeaderSnapshot): void {
    const normalized = normalizeSnapshot(next);
    if (sameSnapshot(this.snapshot, normalized)) return;

    if (this.snapshot.sessionId !== normalized.sessionId) {
      this.announcements.push(`Session changed to ${changedValue(normalized.sessionId)}.`);
    }
    if (this.snapshot.modelId !== normalized.modelId) {
      this.announcements.push(`Model changed to ${changedValue(normalized.modelId)}.`);
    }
    if (this.snapshot.trust !== normalized.trust) {
      this.announcements.push(`Workspace trust changed to ${normalized.trust.toUpperCase()}.`);
    }
    this.snapshot = normalized;
    this.invalidate();
  }

  takeAnnouncements(): readonly string[] {
    const pending = Object.freeze([...this.announcements]);
    this.announcements.length = 0;
    return pending;
  }

  /** Complete alternate output; unlike the visible line this is not viewport-truncated. */
  toPlainText(): string {
    return [
      OCTOCODE_COMPACT_MARK,
      ...(this.snapshot.version === undefined ? [] : [`v${this.snapshot.version}`]),
      OCTOCODE_TAGLINE,
      OCTOCODE_BETA_NOTICE,
      this.allSegments().join(' · '),
    ].join('\n');
  }

  /** Terminal-column measurement exposed for deterministic renderer/tests. */
  static displayWidth(value: string): number {
    return terminalDisplayWidth(value);
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    return [{
      id: 'summary',
      role: 'content',
      text: renderOctocodeBannerLines({
        width: this.snapshot.width,
        ...(this.snapshot.version === undefined ? {} : { version: this.snapshot.version }),
        statusLine: this.visibleLine(),
      }).join('\n'),
    }];
  }

  private allSegments(): readonly string[] {
    return [
      this.snapshot.title,
      this.snapshot.working.toUpperCase(),
      `trust ${this.snapshot.trust.toUpperCase()}`,
      ...(this.snapshot.modelId === undefined ? [] : [`model ${this.snapshot.modelId}`]),
      ...(this.snapshot.sessionId === undefined ? [] : [`session ${this.snapshot.sessionId}`]),
    ];
  }

  private visibleLine(): string {
    const { width } = this.snapshot;
    const required = [
      this.snapshot.title,
      this.snapshot.working.toUpperCase(),
      `trust ${this.snapshot.trust.toUpperCase()}`,
    ];
    const optionals = [
      ...(this.snapshot.modelId === undefined ? [] : [`model ${this.snapshot.modelId}`]),
      ...(this.snapshot.sessionId === undefined ? [] : [`session ${this.snapshot.sessionId}`]),
    ];
    let segments = [...required];
    for (const optional of optionals) {
      const candidate = [...segments, optional].join(' · ');
      if (terminalDisplayWidth(candidate) <= width) segments.push(optional);
    }
    const requiredLine = required.join(' · ');
    if (terminalDisplayWidth(requiredLine) <= width) return segments.join(' · ');

    const state = `${required[1]} · ${required[2]}`;
    const separatorWidth = terminalDisplayWidth(' · ');
    const titleWidth = width - terminalDisplayWidth(state) - separatorWidth;
    if (titleWidth >= 2) return `${fitTerminalText(required[0] ?? '', titleWidth)} · ${state}`;

    // Trust is the highest-priority safety state when the viewport cannot fit
    // title plus both states. The complete alternate output retains everything.
    return fitTerminalText(`${required[2]} · ${required[1]}`, width);
  }
}
