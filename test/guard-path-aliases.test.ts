/**
 * The self-destruction guard compares paths as strings, and Windows accepts
 * several spellings for the same directory. Two of them walked past the guard.
 *
 * Measured against a running Bridge (turn-42 audit): `delete` aimed at the
 * workspace root was refused as `C:\...\open-bridge-app`, `C:\USERS\...` and
 * mixed case — but `\\?\C:\...\open-bridge-app` went through, and so did
 * `C:\...\open-bridge-app.`. The filesystem accepts both as that same
 * directory (`\\?\` is the long-path prefix; the Win32 layer strips trailing
 * dots from a segment before opening it).
 *
 * That matters because of what the guard is for: the call nobody means to make
 * — `delete "."`, a delete that lands on the workspace root. Its strength should
 * not depend on which spelling the model happened to produce. An alias is not
 * something a caller reaches for by accident, but a guard that only holds for one
 * spelling of a path is not a guard, and this one exists precisely for the
 * unrecoverable case.
 *
 * The comparison key is what these tests pin; the refusal itself is proved end to
 * end in file-op-guards-integration.test.mjs against a real serve process.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import { normalizeGuardPath } from "../src/bridge/tools/file-tools.js";

const IS_WINDOWS = process.platform === "win32";
const WIN_ROOT = "C:\\projects\\current";
const POSIX_ROOT = "/projects/current";
const ROOT = IS_WINDOWS ? WIN_ROOT : POSIX_ROOT;

test("the long-path prefix is stripped, so \\?\\ spellings compare equal", t => {
  if (!IS_WINDOWS) return t.skip("\\\\?\\ is a Windows path form");
  // String.raw so the literals below read as the paths themselves rather than
  // as another layer of escapes: this test is about backslash spellings.
  assert.equal(normalizeGuardPath(String.raw`\\?\C:\projects\current`), path.resolve(WIN_ROOT));
  assert.equal(normalizeGuardPath("//?/C:/projects/current"), path.resolve(WIN_ROOT));
  // The device form \\.\ names the same thing.
  assert.equal(normalizeGuardPath(String.raw`\\.\C:\projects\current`), path.resolve(WIN_ROOT));
  // UNC keeps its server/share meaning instead of degrading to a relative path.
  assert.equal(normalizeGuardPath(String.raw`\\?\UNC\server\share\proj`), path.resolve(String.raw`\\server\share\proj`));
  assert.equal(normalizeGuardPath(String.raw`\\?\UNC\server\share\proj.\x`), path.resolve(String.raw`\\server\share\proj\x`));
});

test("trailing dots and spaces are stripped per segment", t => {
  if (!IS_WINDOWS) return t.skip("Win32 strips these; POSIX names are taken literally");
  assert.equal(normalizeGuardPath(`${WIN_ROOT}.`), path.resolve(WIN_ROOT));
  assert.equal(normalizeGuardPath(`${WIN_ROOT} `), path.resolve(WIN_ROOT));
  assert.equal(normalizeGuardPath(`${WIN_ROOT}.\\sub.`), path.resolve(path.join(WIN_ROOT, "sub")));
  // (a raw literal cannot END in a backslash: it would escape its own quote)
  assert.equal(normalizeGuardPath(String.raw`\\?\C:\projects\current.` + "\\"), path.resolve(WIN_ROOT));
});

test("a POSIX path keeps its trailing dots: there they are real names", t => {
  if (IS_WINDOWS) return t.skip("POSIX-only spelling");
  // Normalizing these away would merge two genuinely different directories,
  // which would turn a legitimate path into a false refusal.
  assert.equal(normalizeGuardPath(`${POSIX_ROOT}.`), path.resolve(`${POSIX_ROOT}.`));
  assert.equal(normalizeGuardPath(`${POSIX_ROOT} `), path.resolve(`${POSIX_ROOT} `));
});

test("parent segments survive normalization, and ordinary paths are untouched", () => {
  // Stripping trailing dots must not eat the one segment where dots carry
  // meaning. path.join collapses the .. before the guard ever sees the string,
  // so the traversal is written out and handed to the guard unresolved.
  const withDotDot = `${ROOT}${path.sep}..`;
  assert.equal(normalizeGuardPath(withDotDot), path.resolve(IS_WINDOWS ? "C:\\projects" : "/projects"));
  assert.notEqual(normalizeGuardPath(withDotDot), path.resolve(ROOT),
    "a parent traversal must not collapse into the directory itself");
  assert.equal(normalizeGuardPath(`${ROOT}${path.sep}..${path.sep}..`),
    path.resolve(IS_WINDOWS ? "C:\\" : "/"));
  assert.equal(normalizeGuardPath(`${ROOT}${path.sep}.${path.sep}..${path.sep}..${path.sep}..`),
    path.resolve(IS_WINDOWS ? "C:\\" : "/"), "segments and .. still compose the way path.resolve says");
  // An ordinary path is returned unchanged...
  assert.equal(normalizeGuardPath(ROOT), path.resolve(ROOT));
  // ...and the workspace root keeps comparing equal to itself, which is the case
  // the guard exists for.
  assert.equal(normalizeGuardPath(`${ROOT}${path.sep}.`), path.resolve(ROOT));
});
