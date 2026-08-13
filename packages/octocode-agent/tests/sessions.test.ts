import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessions } from '../src/sessions.js';

let tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-sessions-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  tmps = [];
});

// This test pins the exact Pi session-header contract that sessions.ts depends
// on. The fixture below is a VERBATIM first JSONL line as written by Pi
// (`~/.pi/agent/sessions/<bucket>/<ts>_<uuid>.jsonl`), key order and all:
//   keys = type,version,id,timestamp,cwd  (confirmed against a live 0.80.3 file)
// If a future Pi release renames/moves `type`, `id`, or `cwd`, this breaks
// loudly instead of the launcher silently listing nothing.
const REAL_PI_HEADER =
  '{"type":"session","version":3,"id":"019f4767-328d-7402-a0e3-4f57a6ebc73a",' +
  '"timestamp":"2026-07-09T15:02:53.325Z","cwd":"/Users/bgaryy/code/octocode-server"}';

describe('sessions header contract (real Pi bytes)', () => {
  it('extracts id + cwd from a verbatim Pi session header line', () => {
    const root = tmpRoot();
    const bucket = path.join(root, '--Users-bgaryy-code-octocode-server--');
    fs.mkdirSync(bucket, { recursive: true });
    const file = path.join(bucket, '2026-07-09T15-02-53-325Z_019f4767-328d-7402-a0e3-4f57a6ebc73a.jsonl');
    // Header line + a following event line, as a real session file has.
    fs.writeFileSync(file, REAL_PI_HEADER + '\n{"type":"message","role":"user"}\n');

    const all = listSessions(root);
    expect(all).toHaveLength(1);
    expect(all[0].uuid).toBe('019f4767-328d-7402-a0e3-4f57a6ebc73a');
    expect(all[0].cwd).toBe('/Users/bgaryy/code/octocode-server');
  });

  it('ignores a first line whose type is not "session" (schema drift guard)', () => {
    const root = tmpRoot();
    const bucket = path.join(root, '--p--');
    fs.mkdirSync(bucket, { recursive: true });
    // type renamed → header treated as absent → cwd falls back to decoded bucket,
    // uuid falls back to the filename segment. Proves we never trust a wrong shape.
    fs.writeFileSync(
      path.join(bucket, 'ts_019f0000-0000-7000-8000-000000000000.jsonl'),
      '{"type":"session-header","id":"x","cwd":"/should/not/be/used"}\n',
    );
    const all = listSessions(root);
    expect(all).toHaveLength(1);
    expect(all[0].uuid).toBe('019f0000-0000-7000-8000-000000000000');
    expect(all[0].cwd).toBe('/p');
  });
});
