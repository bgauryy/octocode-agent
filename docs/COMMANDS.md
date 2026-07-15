# Command reference

This repo uses Yarn 4 workspaces. Run root commands from the repository root. Run package commands with `yarn workspace <package-name> <script>` unless you are already in that package directory.

## Root workspace scripts

Defined in `package.json`.

| Command | What it does |
| --- | --- |
| `yarn build` | Runs `build` in every workspace package, topologically and including private workspaces. |
| `yarn lint` | Runs each workspace package's lint check. In this slice, package linting is TypeScript `--noEmit`. |
| `yarn lint:fix` | Runs `lint:fix` in every workspace that defines it. This checkout currently has no package-level `lint:fix`, so Yarn may report missing scripts. |
| `yarn test` | Runs each workspace package's test suite. |
| `yarn test:quiet` | Runs `test:quiet` in every workspace that defines it. This checkout currently has no package-level `test:quiet`, so Yarn may report missing scripts. |
| `yarn typecheck` | Runs each workspace package's TypeScript type check. |
| `yarn build:native:all` | Delegates to `@octocodeai/octocode-engine` `build:all`. The engine workspace is not present in this checkout, so it only works in the full monorepo. |
| `yarn platforms:check` | Delegates to `@octocodeai/octocode-engine` `platforms:check`. Requires the full monorepo engine workspace. |
| `yarn build:publish` | Runs `prepublish`, native engine build, platform checks, then `@octocodeai/mcp` `build:publish`. Requires full monorepo packages that are not present in this checkout. |
| `yarn docs:verify` | Runs `node ./scripts/docs-verify.mjs`. The backing root `scripts/` directory is not present in this checkout. |
| `yarn health:check` | Runs `node ./scripts/workspace-health.mjs check`. The backing root `scripts/` directory is not present in this checkout. |
| `yarn health:report` | Runs `node ./scripts/workspace-health.mjs report`. The backing root `scripts/` directory is not present in this checkout. |
| `yarn local:check` | Runs `node ./release/sync-packages-local.mjs` to check workspace-local dependency specs. The backing root `release/` directory is not present in this checkout. |
| `yarn local:fix` | Runs `node ./release/sync-packages-local.mjs --fix` to rewrite package specs for local development. Requires the root `release/` script. |
| `yarn sync:version` | Runs `node ./release/sync-packages-version.mjs` to sync package versions. Requires the root `release/` script. |
| `yarn sync:version:publish` | Runs `node ./release/sync-packages-version.mjs --pin-for-publish` to replace workspace refs with publishable semver pins. Requires the root `release/` script. |
| `yarn deps:dedupe` | Runs `node ./scripts/dedupe-deps.mjs` to report dependency dedupe opportunities. Requires the root `scripts/` script. |
| `yarn deps:dedupe:fix` | Runs `node ./scripts/dedupe-deps.mjs --fix` to apply dependency dedupe fixes. Requires the root `scripts/` script. |

## `octocode-agent` package scripts

Package: `packages/octocode-agent` (`octocode-agent`).

| Command | What it does |
| --- | --- |
| `yarn workspace octocode-agent build` | Compiles TypeScript from `src/` to `out/` using `tsconfig.json`. Required before running the package bin from source. |
| `yarn workspace octocode-agent start` | Runs `node ./bin/octocode-agent.mjs`, which loads the compiled launcher from `out/launcher.js`. |
| `yarn workspace octocode-agent lint` | Runs `tsc --noEmit -p tsconfig.json`. |
| `yarn workspace octocode-agent typecheck` | Same as `lint`: TypeScript type checking without emitting files. |
| `yarn workspace octocode-agent test` | Runs the Vitest suite once. |
| `yarn workspace octocode-agent test:watch` | Runs Vitest in watch mode. |
| `yarn workspace octocode-agent test:coverage` | Runs Vitest with coverage enabled. |
| `yarn workspace octocode-agent verify` | Runs `typecheck` and then `test`. |
| `yarn workspace octocode-agent check:no-workspace` | Fails if published dependency fields contain `workspace:` specs or unpublished runtime packages. |
| `yarn workspace octocode-agent prepack` | Publish lifecycle guard: runs `check:no-workspace` and then `build`. |
| `yarn workspace octocode-agent prepublishOnly` | Publish lifecycle guard: runs `check:no-workspace`. |

## `octocode-agent` executable

The npm bin is `octocode-agent`, backed by `packages/octocode-agent/bin/octocode-agent.mjs`. It is a thin shim over the compiled launcher in `out/launcher.js`.

| Command | What it does |
| --- | --- |
| `octocode-agent [pi args...]` | Launches Pi with the Octocode core extension. Unknown arguments are forwarded to Pi. |
| `octocode-agent update` or `octocode-agent --update` | Self-updates the platform with `npm install -g octocode-agent@latest`. |
| `octocode-agent update core` | Updates only `@octocodeai/pi-extension` inside the launcher install with `npm install --prefix <launcher-root> --omit=dev @octocodeai/pi-extension@latest`. |
| `octocode-agent --version`, `octocode-agent -v`, or `octocode-agent version` | Prints launcher, core extension, Pi host, and launch-mode versions. |
| `octocode-agent --agent-help` | Prints launcher-specific help. Use Pi help flags for forwarded Pi runtime options. |
| `octocode-agent config` | Prints launch mode, Octocode home, Pi agent directory, core spec/version, Pi binary/version, launcher version, detected API-key names, and relevant env overrides. |
| `octocode-agent setup` | Runs first-run diagnostics and tells the user what to fix before starting. |
| `octocode-agent auth` | Prints API-key setup instructions and shows which supported key names are currently detected. |
| `octocode-agent models` | Prints model selection/configuration guidance for startup flags and in-session `/model`. |
| `octocode-agent sessions` | Prints session storage location plus resume, continue, no-session, name, and in-session session commands. |

Useful launcher environment variables:

| Variable | Effect |
| --- | --- |
| `OCTOCODE_LAUNCHER_MODE=subprocess` | Forces the launcher to spawn the Pi binary instead of using the SDK embed path. |
| `OCTOCODE_PI_BIN=/absolute/path/to/pi` | Uses a locally built Pi binary. |
| `OCTOCODE_PI_PACKAGE=<npm-package>` | Overrides the Pi host package name used for resolution/version reporting. |
| `OCTOCODE_AGENT_EXTENSION_SPEC=<spec>` | Overrides the extension spec passed to Pi. |
| `OCTOCODE_AGENT_CLEAN=1` | In subprocess mode, adds `--no-skills` and `--no-context-files`. |
| `OCTOCODE_AGENT_NO_CONTEXT_FILES=1` | In subprocess mode, adds `--no-context-files`. |
| `OCTOCODE_AGENT_FULL_TOOLS=1` | In subprocess mode, keeps Pi's built-in `grep`, `find`, and `ls`; by default they are excluded in favor of Octocode tools. |

## `@octocodeai/pi-extension` package scripts

Package: `packages/octocode-pi-extension` (`@octocodeai/pi-extension`).

| Command | What it does |
| --- | --- |
| `yarn workspace @octocodeai/pi-extension build` | Runs `scripts/build.mjs`: syncs package skills, cleans `dist/`, compiles TypeScript, copies prompt section Markdown, composes `dist/system/SYSTEM_PROMPT.md`, copies skills and subagents, injects `octocode-config.mjs` into skill script directories, and bundles the Octocode CLI if `packages/octocode/out/octocode.js` exists. |
| `yarn workspace @octocodeai/pi-extension build:skills` | Runs `scripts/build.mjs --skills-only`: refreshes `packages/octocode-pi-extension/skills` from root `skills/` directories that contain `SKILL.md`. In this checkout root `skills/` is optional and may be absent. |
| `yarn workspace @octocodeai/pi-extension clean` | Runs `scripts/build.mjs --clean`: removes `packages/octocode-pi-extension/dist`. |
| `yarn workspace @octocodeai/pi-extension lint` | Runs `tsc --noEmit -p tsconfig.json`. |
| `yarn workspace @octocodeai/pi-extension typecheck` | Same as `lint`: TypeScript type checking without emitting files. |
| `yarn workspace @octocodeai/pi-extension test` | Builds the package, then runs Vitest once. |
| `yarn workspace @octocodeai/pi-extension test:unit` | Runs Vitest once without first building. |
| `yarn workspace @octocodeai/pi-extension test:watch` | Runs Vitest in watch mode. |
| `yarn workspace @octocodeai/pi-extension test:coverage` | Runs Vitest with coverage enabled. |
| `yarn workspace @octocodeai/pi-extension verify` | Runs `typecheck` and then `test`. |
| `yarn workspace @octocodeai/pi-extension check:no-workspace` | Fails if published dependency fields contain local-only `workspace:` or `file:` specs. |
| `yarn workspace @octocodeai/pi-extension prepack` | Publish lifecycle guard: runs `check:no-workspace` and then `build`. |
| `yarn workspace @octocodeai/pi-extension prepublishOnly` | Publish lifecycle guard: runs `check:no-workspace`. |

## Direct script entrypoints

These are normally invoked through package scripts, but can be run directly when debugging.

| Command | What it does |
| --- | --- |
| `node packages/octocode-pi-extension/scripts/build.mjs` | Full pi-extension build. |
| `node packages/octocode-pi-extension/scripts/build.mjs --skills-only` | Refresh only the package skill source tree. |
| `node packages/octocode-pi-extension/scripts/build.mjs --clean` | Remove the pi-extension `dist/` directory. |
| `node packages/octocode-agent/scripts/check-no-workspace-protocol.mjs` | Run the `octocode-agent` publish dependency guard directly. |
| `node packages/octocode-pi-extension/scripts/check-no-workspace-protocol.mjs` | Run the `@octocodeai/pi-extension` publish dependency guard directly. |

## Notes for this checkout

- Only `packages/octocode-agent` and `packages/octocode-pi-extension` are present under `packages/`.
- Some root scripts reference full-monorepo packages or root `scripts/`/`release/` files that are not present in this checkout. They are documented because they are still defined in the root manifest, but they will not run successfully here without the missing files/packages.
- The vendored Octocode CLI path mentioned by package docs, `packages/octocode/out/octocode.js`, is optional for this slice. The pi-extension build skips bundling it when absent and relies on the published `octocode` runtime dependency instead.
