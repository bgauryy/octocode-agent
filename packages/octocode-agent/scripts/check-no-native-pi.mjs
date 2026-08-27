import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [path.join(packageRoot, 'src'), path.join(packageRoot, 'out')];
const forbidden = [
  /@earendil-works\/pi-(?:coding-agent|agent-core|ai|tui)/,
  /pi-coding-agent/,
  /OCTOCODE_PI_(?:BIN|PACKAGE)/,
];

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? filesUnder(absolute) : [absolute];
  });
}

const violations = [];
for (const file of roots.flatMap(filesUnder)) {
  if (!/\.(?:[cm]?[jt]s|d\.ts)$/.test(file)) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const pattern of forbidden) {
    if (pattern.test(source)) violations.push(`${path.relative(packageRoot, file)}: ${pattern.source}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (/^@earendil-works\/pi-/.test(name)) violations.push(`package.json ${section}.${name}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Native Pi dependency guard failed:\n${violations.map((item) => `- ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Native Pi dependency guard passed.\n');
}
