import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('Awareness architecture boundaries', () => {
  it('imports notification SQL from its owning module, not the aggregate SQL barrel', () => {
    const consumers = ['notifications-core.ts', 'notifications-inbox.ts', 'notifications-signals.ts'];
    const violations = consumers.filter((file) => readFileSync(join(packageRoot, 'src', file), 'utf8')
      .includes("./sql/index.js"));
    expect(violations).toEqual([]);
  });
});
