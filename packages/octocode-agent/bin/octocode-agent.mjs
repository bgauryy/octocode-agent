#!/usr/bin/env node
// Thin shim — the real launcher is compiled TypeScript in ../out/launcher.js.
// Run `yarn build` in this package to compile src/ → out/ before first use.
import { main } from '../out/launcher.js';
process.exitCode = await main(process.argv.slice(2));
