import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const allowedPackage = path.join(packageRoot, "octocode-pi-extension");
const executableExtension = /\.(?:[cm]?[jt]s|tsx)$/u;
const piSpecifier = ["@earendil-works", "pi-"].join("/");

function executableFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (["dist", "node_modules", "out", "target"].includes(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...executableFiles(absolute));
    else if (executableExtension.test(entry.name)) files.push(absolute);
  }
  return files;
}

describe("Pi dependency boundary", () => {
  test("confines Pi dependencies and executable imports to the Pi extension", () => {
    const violations: string[] = [];
    for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packagePath = path.join(packageRoot, entry.name);
      if (packagePath === allowedPackage) continue;

      const manifestPath = path.join(packagePath, "package.json");
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<
          string,
          unknown
        >;
        for (const section of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ]) {
          const dependencies = manifest[section];
          if (!dependencies || typeof dependencies !== "object") continue;
          for (const dependency of Object.keys(dependencies)) {
            if (dependency.startsWith(piSpecifier))
              violations.push(`${entry.name}/package.json:${section}:${dependency}`);
          }
        }
      }

      for (const file of executableFiles(packagePath)) {
        if (file === import.meta.filename) continue;
        if (fs.readFileSync(file, "utf8").includes(piSpecifier))
          violations.push(path.relative(packageRoot, file));
      }
    }

    expect(violations).toEqual([]);
  });
});
