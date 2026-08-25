/**
 * embed.ts — semantic-embedding primitives for Awareness Lite.
 *
 * The implementation is shared with the full Awareness store via
 * `@octocodeai/octocode-shared/embed` (pure, `node:child_process` only, no npm
 * deps). This module stays as Lite's local import surface (re-export) so
 * `./embed.js` importers keep working and Lite keeps its zero-dependency shape.
 */
export {
bytesToEmbedding,cosineSimilarity,
embeddingToBytes,isEmbeddingEnabled,resolveEmbedCommand,runHostEmbedder,type HostEmbedding
} from '@octocodeai/octocode-shared/embed';
