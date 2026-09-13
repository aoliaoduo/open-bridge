/**
 * Every `/api` route keeps a caller.
 *
 * The console is the operator's main surface, so a route nobody calls is either a
 * missing control or dead code — and the difference is worth knowing rather than
 * assuming. This test reads the route table out of `src/server/api-router.ts` and
 * looks for the path anywhere it could legitimately be used: the console
 * (`ui/src`), the CLI, and the integration suites. A route with no caller fails
 * the test until someone decides which of the three it is: wire it up, delete it,
 * or add it to SERVER_OWNED_ROUTES below with a reason.
 *
 * SERVER_OWNED_ROUTES exists because "no console caller" is sometimes the design
 * rather than an omission. The clearest case is the lifecycle: the instance is
 * owned by the terminal that runs `serve` (open it, the bridge runs; close it,
 * everything stops), so the console deliberately has no start/stop/restart
 * buttons. `/api/bridge/*` stays as API surface for the CLI, scripts and a future
 * desktop shell — and the previous attempt to turn it into console buttons is
 * exactly the mistake this list documents.
 *
 * It is deliberately a source-text check, like `tool-call-shape.test.ts` reading
 * the dispatcher's handler table: importing the router would initialize the host,
 * the config and the state, which a unit test must not do to a real environment.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/**
 * Routes that intentionally have no caller in this repository, with the reason.
 *
 * Empty today: every route currently has one (the console, the CLI, or a suite),
 * and the second assertion below keeps this list from rotting when that changes.
 * The expected future entry is the lifecycle pair — `/bridge/start` and
 * `/bridge/stop` exist for the CLI, scripts and a desktop shell, and the console
 * deliberately has no buttons for them (the terminal owns the process; see this
 * file's header). Today the integration and UI suites still exercise them, so
 * they are not orphaned and do not belong here yet.
 */
const SERVER_OWNED_ROUTES: Readonly<Record<string, string>> = {};

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

test("every /api route has a caller, or a written reason it does not", () => {
  const known = routes();
  assert.ok(known.length >= 15, `the route table still parses; saw ${known.length} routes`);

  const texts = callerFiles().map(file => readFileSync(file, "utf8"));
  const orphans = known.filter(route => !texts.some(text => text.includes(`/api${route}`)));
  const unexplained = orphans.filter(route => !(route in SERVER_OWNED_ROUTES));
  assert.deepEqual(
    unexplained,
    [],
    `these routes have no caller anywhere — wire them up, delete them, or list them in SERVER_OWNED_ROUTES with a reason: ${unexplained.join(", ")}`,
  );

  // And the allowlist may not rot: a listed route that HAS a caller is stale.
  const stale = Object.keys(SERVER_OWNED_ROUTES).filter(route => !orphans.includes(route));
  assert.deepEqual(stale, [], `these routes are listed as server-owned but do have a caller: ${stale.join(", ")}`);
});

test("the console drives the routes it owns and leaves the lifecycle alone", () => {
  const client = readFileSync(path.join(repoRoot, "ui", "src", "api.ts"), "utf8");
  // The panel's own verbs: reading state, rotating the endpoint (an in-process
  // token flip, which is why it is safe from the page), closing a session, and
  // acting on a project service.
  for (const route of ["/api/status", "/api/bridge/rotate", "/api/sessions/close", "/api/services/action"]) {
    assert.ok(client.includes(route), `ui/src/api.ts must call ${route}`);
  }
  // The lifecycle routes are the terminal's: the page must not grow buttons that
  // stop the very listener serving it (that mistake is in the git history).
  for (const route of ["/api/bridge/start", "/api/bridge/stop", "/api/shutdown"]) {
    assert.ok(!client.includes(route), `ui/src/api.ts must not call ${route}: the terminal owns the lifecycle`);
  }
});
