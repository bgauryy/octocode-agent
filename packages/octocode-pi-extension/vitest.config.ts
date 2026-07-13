import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Clear shell-inherited env vars that alter extension behaviour under test.
    // OCTOCODE_PI_SUBAGENT=1 causes registerAgentTools() to early-return,
    // so spawnAgent / AgentMessage would never be registered.
    env: {
      OCTOCODE_PI_SUBAGENT: '',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/ambient.d.ts',
        'src/types.ts',
        // Pure re-export shims — coverage is attributed to the upstream packages
        // they forward (@octocodeai/config and @octocodeai/octocode-awareness).
        // Including them produces misleading 0% rows with no signal.
        'src/env.ts',
        'src/awareness.ts',
      ],
      thresholds: {
        // branches: CDP/bash-subprocess paths require live Chrome/OS — 65% is the
        // realistic floor. Raise this as new integration harnesses land.
        // statements/lines/functions cover pure logic; keep these higher.
        // Never lower these numbers without a code-reviewed justification.
        branches: 65,
        functions: 80,
        lines: 85,
        statements: 80,
      },
    },
  },
});
