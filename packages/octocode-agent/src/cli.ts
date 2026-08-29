import { fatalErrorReport, main } from './launcher.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${fatalErrorReport(error)}\n`);
  process.exitCode = 1;
}
