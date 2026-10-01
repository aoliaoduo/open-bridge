import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const FACADE = path.join(SRC, "bridge", "state.ts");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

test("internal source imports bridge state from its owning modules, not the compatibility facade", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (path.resolve(file) === path.resolve(FACADE)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
      if (resolved === path.resolve(FACADE)) {
        offenders.push(path.relative(ROOT, file).split(path.sep).join("/"));
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "state.ts is a compatibility facade only; internal code should import runtime-state/activity/endpoint/mcp-result directly",
  );
});
