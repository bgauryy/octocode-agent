# Develop against a Pi fork

`octocode-agent` does not bundle or launch Pi. Use a Pi fork only with the independently
installed `@octocodeai/pi-extension` package and the fork's own Pi host command.

## Scope

A Pi fork can change Pi-owned behavior such as its model loop, sessions, built-in commands,
or TUI. The Octocode extension continues to own its tools, prompt section, MCP loader,
skill directories, and subagents.

The native `octocode-agent` package is outside this workflow. Do not add a Pi fork, the Pi
extension, or Pi-specific environment variables to its dependencies or launcher.

## Build the fork

Follow the fork's repository instructions for installation, build, and tests. The supported
upstream source is `https://github.com/earendil-works/pi`.

If you rename or publish the fork, preserve its Pi extension-loading contract. Install
`@octocodeai/pi-extension` into that Pi environment and load it through the Pi host's
documented extension mechanism.

## Compatibility requirements

The extension declares the Pi packages (`@earendil-works/pi-*`) as peer dependencies and
performs no host-version check at runtime; its tested Pi version is the dev dependency in
`packages/octocode-pi-extension/package.json`.

Before using a fork with the extension:

1. Keep the fork's extension API compatible with that tested Pi version.
2. Build `@octocodeai/pi-extension`.
3. Run the extension's unit and end-to-end tests.
4. Load the built extension through the actual Pi extension loader.
5. Exercise startup, registration, one turn, tool execution, session resume, compaction, and shutdown.

## Native boundary

The native release must continue to satisfy `yarn workspace octocode-agent
check:no-native-pi`. A Pi fork must not introduce native imports, subprocess fallbacks,
package resolution, installers, update paths, or rollback dependencies.

See [Historical Pi launcher integration](PI_INTEGRATION.md) for the former native boundary
and the current package ownership rules.
