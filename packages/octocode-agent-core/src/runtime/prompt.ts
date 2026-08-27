export interface PromptFragment { readonly id: string; readonly placement: 'system' | 'before-user' | 'after-user'; readonly priority: number; readonly content: string; readonly provenance: string; readonly trusted: boolean; }
export interface PromptSnapshot { readonly schemaVersion: 1; readonly text: string; readonly fragments: readonly { readonly id: string; readonly placement: PromptFragment['placement']; readonly provenance: string; readonly bytes: number }[]; readonly bytes: number; readonly semanticDigest: string; }
export const assemblePrompt = (fragments: readonly PromptFragment[]): PromptSnapshot => {
  const ordered = [...fragments].sort((a, b) => placementOrder(a.placement) - placementOrder(b.placement) || a.priority - b.priority || a.id.localeCompare(b.id));
  if (ordered.some((fragment) => !fragment.trusted)) throw new Error('Untrusted prompt fragment');
  const text = ordered.map(({ content }) => content).join('\n\n');
  return { schemaVersion: 1, text, fragments: ordered.map(({ id, placement, provenance, content }) => ({ id, placement, provenance, bytes: byteLength(content) })), bytes: byteLength(text), semanticDigest: fnv1a(text) };
};
const placementOrder = (placement: PromptFragment['placement']): number => placement === 'system' ? 0 : placement === 'before-user' ? 1 : 2;
const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
const fnv1a = (value: string): string => { let hash = 0x811c9dc5; for (const byte of new TextEncoder().encode(value)) { hash ^= byte; hash = Math.imul(hash, 0x01000193); } return (hash >>> 0).toString(16).padStart(8, '0'); };
