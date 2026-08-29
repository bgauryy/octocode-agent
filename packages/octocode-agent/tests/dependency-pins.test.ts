import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  dependencies?: Record<string, string>;
}

describe('protocol dependency pins', () => {
  it('keeps wire-protocol SDKs on reviewed exact versions', () => {
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PackageManifest;

    expect(manifest.dependencies).toMatchObject({
      '@agentclientprotocol/sdk': '1.4.0',
      '@modelcontextprotocol/client': '2.0.0',
      openai: '7.8.0',
    });
  });
});
