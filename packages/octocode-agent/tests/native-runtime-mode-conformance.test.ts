import { describe, expect, it } from 'vitest';
import { createAcpRuntimeArgs } from '../src/launcher.js';

describe('native runtime mode conformance', () => {
  it('identifies ACP independently from its JSON wire output', () => {
    expect(createAcpRuntimeArgs()).toMatchObject({ mode: 'acp', outputFormat: 'json' });
  });
});
