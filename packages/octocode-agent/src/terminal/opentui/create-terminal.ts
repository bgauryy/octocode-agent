import {
  type OpenTuiTerminal,
  type OpenTuiTerminalDependencies,
} from './presentation.js';
import { createOpenTuiStore, type OpenTuiStore } from './state/view-store.js';
import { OpenTuiTerminalController } from './terminal-controller.js';

/** Composition root for the state store and terminal lifecycle controller. */
export function createOpenTuiTerminal(
  dependencies: OpenTuiTerminalDependencies<OpenTuiStore>,
): OpenTuiTerminal {
  const store = createOpenTuiStore();
  return new OpenTuiTerminalController(dependencies, store);
}
