/**
 * Every `/api` route keeps a caller.
 *
 * The console is the operator's main surface, so a route nobody calls is either a
 * missing control or dead code — and the difference is worth knowing rather than
 * assuming. This test reads the route table out of `src/server/api-router.ts` and
 * looks for the path anywhere it could legitimately be used: the console
 * (`ui/src`), the CLI, and the integration suites. A route with no caller fails
 * the test until someone decides which of the two it is: wire it up, or delete it.
 *
 * It is deliberately a source-text check, like `tool-call-shape.test.ts` reading
 * the dispatcher's handler table: importing the router would initialize the host,
 * the config and the state, which a unit test must not do to a real environment.
 *
 * Last time it ran for real it found exactly one: `/api/shutdown`, reachable from
 * the CLI but from neither the console nor any test — so "stop everything" from
 * the web panel left the Node process running with no way to end it from the
 * page. The console now has the 退出进程 button, and this test keeps the surface
 * honest from here on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/** Every .ts/.tsx/.mjs file under a directory, recursively. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The route table, read the way the server declares it. */
function routes(): string[] {
  const source = readFileSync(path.join(repoRoot, "src", "server", "api-router.ts"), "utf8");
  const found = [...source.matchAll(/case "(\/[a-z0-9/_-]*)":/g)].map(match => match[1]!);
  return [...new Set(found)].sort();
}

/** Where a route may be called from: the console, the CLI, the suites. */
function callerFiles(): string[] {
  return [
    ...sourceFiles(path.join(repoRoot, "ui", "src")),
    path.join(repoRoot, "src", "cli.ts"),
    ...sourceFiles(path.join(repoRoot, "test")),
  ];
}

test("every /api route is called from the console, the CLI or a test", () => {
  const known = routes();
  assert.ok(known.length >= 15, `the route table still parses; saw ${known.length} routes`);

  const texts = callerFiles().map(file => ({
    file,
    text: readFileSync(file, "utf8"),
  }));

  const orphans = known.filter(route => !texts.some(({ text }) => text.includes(`/api${route}`)));
  assert.deepEqual(
    orphans,
    [],
    `these routes have no caller anywhere — wire them into the console or delete them: ${orphans.join(", ")}`,
  );
});

test("the console's own API client covers the routes it is meant to drive", () => {
  const client = readFileSync(path.join(repoRoot, "ui", "src", "api.ts"), "utf8");
  // One representative per family the panel operates through: reading state,
  // mutating the bridge, acting on sessions, and ending the process. A rename in
  // api-router that misses the console client is what this catches.
  for (const route of ["/api/status", "/api/bridge/stop", "/api/bridge/rotate", "/api/sessions/close", "/api/shutdown"]) {
    assert.ok(client.includes(route), `ui/src/api.ts must call ${route}`);
  }
});
