/**
 * "The build on disk is newer than the code this process loaded."
 *
 * Why this exists: rebuilding `dist/` does nothing to a *running* instance —
 * Node has already loaded the old modules, so new tools and fixes only appear
 * after a restart. Nothing says so: an instance kept advertising the previous
 * tool set, and the only way to find out was to count tools and compare them
 * with the source. This module answers exactly one question, for the operator
 * and for an agent editing this repo: **is what I am looking at the code that
 * is actually running?**
 *
 * Scope, deliberately narrow:
 * - compiled instances only. Under `npm run dev` (tsx) there is no build
 *   artifact to compare with, so the signal is *absent* rather than wrong.
 * - "the build" = the newest modification time of any `.js` file under `dist`,
 *   because every compile rewrites those outputs; a partial rebuild still
 *   moves it forward.
 * - the baseline is taken when this module is imported, i.e. at process start,
 *   which is what "the code I loaded" means.
 * - the disk side is memoized for a few seconds: the status endpoint is polled
 *   by the console, and a directory walk per poll would be pure waste.
 *
 * It never throws and never blocks anything: an unreadable or missing `dist`
 * simply yields no signal.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** How long a disk-side answer is reused, in ms. */
const CHECK_TTL_MS = 5_000;

export interface BuildStaleness {
  /** True when `dist` has been rebuilt since this process loaded its modules. */
  stale: boolean;
  /** Newest build-file mtime observed when the process started. */
  loaded_ms: number;
  /** Newest build-file mtime now. */
  disk_ms: number;
}

/**
 * Where the compiled build lives, or `undefined` when there is none to compare
 * with. The module is at `<repo>/dist/bridge/build-staleness.js` when compiled
 * and at `<repo>/src/bridge/build-staleness.ts` under tsx, so the file
 * extension is the honest discriminator — and it keeps dev mode out of this
 * mechanism entirely instead of reporting a false "stale".
 */
function distDir(): string | undefined {
  const here = fileURLToPath(import.meta.url);
  if (!here.endsWith(".js")) return undefined;
  const dir = dirname(here);
  return dir.endsWith(join("dist", "bridge")) ? dirname(dir) : undefined;
}

/**
 * Newest mtime (ms) among the `.js` files under `dir`, or 0 when there is
 * nothing readable. Non-JS files are ignored: `dist` also holds assets, maps
 * and the vite output, and only the compiled code decides what is running.
 */
export function newestJsMtimeMs(dir: string): number {
  let newest = 0;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // gone or unreadable: nothing to report from here
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      try {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // A rebuild can replace the file between readdir and stat. Skipping it
        // is right: the next check sees the new timestamp anyway.
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * The rule itself, as a pure function so the semantics are testable without a
 * real build: strictly newer counts as stale, equal timestamps do not.
 */
export function evaluateBuildStaleness(loadedMs: number, diskMs: number): BuildStaleness {
  return { stale: diskMs > loadedMs, loaded_ms: loadedMs, disk_ms: diskMs };
}

/** What this process loaded. Captured once, at import time. */
const LOADED_JS_MTIME_MS: number | undefined = (() => {
  const dir = distDir();
  return dir ? newestJsMtimeMs(dir) : undefined;
})();

let cached: { at: number; value: BuildStaleness } | undefined;

/**
 * The sentence to hand a caller when this process is running an older build.
 *
 * Why the signal needs a sentence at all: `bridge_status.build_stale` is the
 * honest answer to "is what I am looking at the code that is running?", but a
 * caller only asks that question once it already suspects the answer. The full
 * cost of not asking was paid here — an agent spent a probe round reporting the
 * running instance's behaviour as the behaviour of the code on disk, and the
 * report was wrong in a way no test could catch, because the code on disk was
 * fine. So the fact rides along with a call the caller already made.
 *
 * `undefined` (dev mode: no build to compare with) and `false` both say nothing:
 * "no signal" is not "stale", and the ordinary case must cost the caller zero
 * tokens.
 */
export function staleBuildAdvice(stale: boolean | undefined): string | undefined {
  if (stale !== true) return undefined;
  return "Note: this Bridge is still running the build it loaded at startup, and dist/ has been "
    + "rebuilt since — fixes and new tools in the current source are NOT live in this process. "
    + "Restart it to load them. (bridge_status reports the same fact as build_stale: true.)";
}

/**
 * Staleness of the running build, or `undefined` when there is nothing to
 * compare with (dev mode, source checkout, unreadable `dist`).
 */
export function buildStaleness(now = Date.now()): BuildStaleness | undefined {
  if (LOADED_JS_MTIME_MS === undefined) return undefined;
  if (cached && now - cached.at < CHECK_TTL_MS) return cached.value;
  const dir = distDir();
  const value = evaluateBuildStaleness(LOADED_JS_MTIME_MS, dir ? newestJsMtimeMs(dir) : 0);
  cached = { at: now, value };
  return value;
}
