import {
  type KeyEvent,
  type KeyBinding as TextareaKeyBinding,
} from '@opentui/core';

export type OpenTuiInteractionKind = 'confirm' | 'select' | 'input' | 'editor';

export interface OpenTuiKeyContext {
  readonly assistOpen?: boolean;
  readonly interaction?: OpenTuiInteractionKind;
  readonly semanticSurfaceFocused?: boolean;
  readonly activeTurn?: boolean;
}

export type OpenTuiKeyAction =
  | 'assist-accept'
  | 'assist-dismiss'
  | 'assist-navigate'
  | 'interaction-cancel'
  | 'interaction-filter'
  | 'interaction-navigate'
  | 'interrupt'
  | 'focus-composer'
  | 'focus-next'
  | 'focus-previous'
  | 'surface-navigate';

type KeyLike = Pick<KeyEvent, 'name'> & Partial<Pick<KeyEvent, 'ctrl' | 'meta' | 'shift'>>;

const NAVIGATION_KEYS = new Set([
  'arrowup', 'arrowdown', 'up', 'down', 'pageup', 'pagedown', 'home', 'end', 'j', 'k',
]);

function normalizedName(key: KeyLike): string {
  return key.name.toLowerCase();
}

function isEscape(name: string): boolean {
  return name === 'escape' || name === 'esc';
}

function isInterrupt(key: KeyLike, name: string): boolean {
  return key.ctrl === true && name === 'c';
}

/** Canonical multiline composer bindings: Enter edits; Ctrl/Meta-Enter submits. */
export function composerKeyBindings(): TextareaKeyBinding[] {
  return [
    { name: 'return', action: 'newline' },
    { name: 'enter', action: 'newline' },
    { name: 'return', ctrl: true, action: 'submit' },
    { name: 'enter', ctrl: true, action: 'submit' },
    { name: 'return', meta: true, action: 'submit' },
    { name: 'enter', meta: true, action: 'submit' },
  ];
}

/** Resolve precedence without performing effects; the renderer remains the effect owner. */
export function resolveOpenTuiKeyAction(
  key: KeyLike,
  context: OpenTuiKeyContext,
): OpenTuiKeyAction | undefined {
  const name = normalizedName(key);

  if (context.assistOpen === true) {
    if (isEscape(name) || isInterrupt(key, name)) return 'assist-dismiss';
    if (name === 'enter' || name === 'return' || name === 'tab') return 'assist-accept';
    if (NAVIGATION_KEYS.has(name)) return 'assist-navigate';
  }

  if (context.interaction !== undefined) {
    if (isEscape(name) || isInterrupt(key, name)) return 'interaction-cancel';
    if (context.interaction === 'confirm'
      && ['y', 'n', 'left', 'right', 'arrowleft', 'arrowright', 'tab'].includes(name)) {
      return 'interaction-navigate';
    }
    if (context.interaction === 'select'
      && ((!key.ctrl && !key.meta && name.length === 1) || name === 'backspace')) {
      return 'interaction-filter';
    }
  }

  if (isInterrupt(key, name)) return 'interrupt';
  if (isEscape(name) && context.activeTurn === true) return 'interrupt';
  if (isEscape(name) && context.semanticSurfaceFocused === true) return 'focus-composer';
  if (name === 'tab' && context.interaction === undefined) {
    return key.shift === true ? 'focus-previous' : 'focus-next';
  }
  if (context.semanticSurfaceFocused === true
    && (NAVIGATION_KEYS.has(name) || name === 'enter' || name === 'return')) {
    return 'surface-navigate';
  }
  return undefined;
}
