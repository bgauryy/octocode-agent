/** Context compaction integration.
 *
 * Pi owns threshold/overflow compaction and continuation. Octocode only wires
 * the session compaction hooks in compaction-hooks.ts; it must not start a
 * second compaction from turn_end because that races Pi's post-run check and
 * aborts otherwise completed tool/assistant turns.
 */
import type { PiInstance, NotifyFn } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { resetCompactionArbiterForTests } from './compaction-state.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

export function registerContextTools(
  pi: PiInstance,
  _Type: TypeBoxBuilder,
  _registeredToolNames: Set<string>,
  _registerFn: RegisterFn,
  _notify: NotifyFn,
): void {
  resetCompactionArbiterForTests();
  // Deliberately no turn_end or message_end registration. Pi's post-run
  // compaction path owns threshold checks, retries, and continuation.
  void pi;
}
