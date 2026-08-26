import { CoordinationMigration } from './coordination-migration.js';
import type { AwarenessOptions } from './coordination-shared.js';

export class AwarenessStore extends CoordinationMigration {}

export function openAwarenessStore(options: AwarenessOptions = {}): AwarenessStore {
  return new AwarenessStore(options);
}
