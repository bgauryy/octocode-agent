import { CoordinationSchema } from './coordination-schema.js';
import type { AwarenessOptions } from './coordination-shared.js';

export class AwarenessStore extends CoordinationSchema {}

export function openAwarenessStore(options: AwarenessOptions = {}): AwarenessStore {
  return new AwarenessStore(options);
}
