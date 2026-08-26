/**
 * embed-host.ts — optional host embedder for CLI --semantic ranking.
 *
 * The implementation is shared with Awareness via
 * `@octocodeai/octocode-shared/embed` (pure, `node:child_process` only, no npm
 * runtime deps). This module stays as the Awareness-local import surface
 * (re-export) so every `./embed-host.js` importer and test keeps working and
 * Awareness keeps its zero-dependency guarantee.
 *
 * Set OCTOCODE_EMBED_CMD to a shell command that reads UTF-8 text on stdin and
 * prints JSON on stdout: { "embedding": number[], "model"?: string }.
 */
export {
  resolveEmbedCommand,
  runHostEmbedder,
  type HostEmbedding,
} from '@octocodeai/octocode-shared/embed';
