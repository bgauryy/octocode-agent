/**
 * sqlite-runtime.ts — embedded-SQLite version gating for safe concurrent WAL.
 *
 * The policy now lives in `@octocodeai/octocode-shared/sqlite-version` so the
 * full store and Awareness share one WAL-safety assessment. This module
 * stays as the Awareness-local import surface (re-export) to keep every existing
 * `./sqlite-runtime.js` importer and test working unchanged. The shared module
 * pulls in no npm runtime deps (a `node:sqlite` type import only), so Awareness
 * keeps its zero-dependency guarantee.
 */
export {
  assessConcurrentWalSafety,
  assertConcurrentWalSafe,
  journalModeForSqliteVersion,
  inspectSqliteRuntime,
  type ConcurrentWalSafety,
} from '@octocodeai/octocode-shared/sqlite-version';
