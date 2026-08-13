import { main } from './launcher.js';

process.exitCode = await main(process.argv.slice(2));
