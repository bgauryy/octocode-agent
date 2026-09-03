import { fileURLToPath } from "node:url";

import { runWithInteractiveFfi } from "./cli-bootstrap.js";
import { fatalErrorReport, main } from "./launcher.js";

try {
  const argv = process.argv.slice(2);
  process.exitCode = await runWithInteractiveFfi(argv, () => main(argv), {
    entrypoint: fileURLToPath(import.meta.url),
  });
} catch (error) {
  process.stderr.write(`${fatalErrorReport(error)}\n`);
  process.exitCode = 1;
}
