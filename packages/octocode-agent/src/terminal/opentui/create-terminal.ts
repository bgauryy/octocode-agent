import {
  createPresentationStore,
  type OpenTuiTerminal,
  type OpenTuiTerminalDependencies,
} from './presentation.js';
import { OpenTuiTerminalController } from './terminal-controller.js';

/** Composition root for the state store and terminal lifecycle controller. */
export function createOpenTuiTerminal(
  dependencies: OpenTuiTerminalDependencies,
): OpenTuiTerminal {
  const store = dependencies.store ?? createPresentationStore();
  return new OpenTuiTerminalController(dependencies, store);
}
