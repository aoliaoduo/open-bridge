import assert from "node:assert/strict";
import test from "node:test";
import { matchFile, globToRegExp, isPathGlob } from "../src/mcp/glob.js";

test("basename simple pattern stays loose (contains)", () => {
  assert.equal(matchFile("src/index.ts", "index"), true);
  assert.equal(matchFile("src/MyFile.TS", "myfile"), true); // case-insensitive
  assert.equal(matchFile("src/a.ts", "*.ts"), true);
});

test("simple wildcards are anchored (no false extension matches)", () => {
  assert.equal(matchFile("src/app.tsx", "*.ts"), false);
  assert.equal(matchFile("data.tsv", "*.ts"), false);
  assert.equal(matchFile("notes.ts.bak", "*.ts"), false);
  assert.equal(matchFile("src/a.ts", "*.ts"), true);
  assert.equal(matchFile("src/app.tsx", "*.tsx"), true);
  assert.equal(matchFile("src/app.test.ts", "*.test.ts"), true);
  assert.equal(matchFile("src/app.test.tsx", "*.test.ts"), false);
  assert.equal(matchFile("src/prefix_name.ts", "prefix*"), true);
  assert.equal(matchFile("src/other.ts", "prefix*"), false);
  assert.equal(matchFile("src/other.ts", "*ther*"), true);
  assert.equal(matchFile("anything", "*"), true);
});

test("star does not cross separators", () => {
  assert.equal(matchFile("src/index.ts", "*.ts"), true);       // basename match
  assert.equal(globToRegExp("*.ts").test("src/index.ts"), false); // full-path: * no slash
  assert.equal(globToRegExp("*.ts").test("index.ts"), true);
});

test("double star crosses separators", () => {
  const re = globToRegExp("src/**/*.ts");
  assert.equal(re.test("src/a.ts"), true);
  assert.equal(re.test("src/x/y/z.ts"), true);
  assert.equal(re.test("src/x/y/z.js"), false);
  assert.equal(matchFile("src/bridge/state.ts", "src/**/*.ts"), true);
});

test("question mark matches one non-separator char", () => {
  assert.equal(matchFile("a1.ts", "a?.ts"), true);
  assert.equal(matchFile("a12.ts", "a?.ts"), false);
});

test("brace alternatives", () => {
  const re = globToRegExp("*.{ts,js}");
  assert.equal(re.test("a.ts"), true);
  assert.equal(re.test("a.js"), true);
  assert.equal(re.test("a.md"), false);
});

test("character class", () => {
  const re = globToRegExp("a[12].ts");
  assert.equal(re.test("a1.ts"), true);
  assert.equal(re.test("a3.ts"), false);
});

test("path glob detection", () => {
  assert.equal(isPathGlob("src/**/*.ts"), true);
  assert.equal(isPathGlob("*.ts"), false);
  assert.equal(isPathGlob("index"), false);
});

test("backslash patterns normalized", () => {
  assert.equal(matchFile("src\\bridge\\view.ts", "src/**/*.ts"), true);
});

test("a leading caret in a character class is a literal, not negation", () => {
  // Glob negation is "!"; "^" is a literal character ("[^x]" matches ^ or x).
  assert.equal(matchFile("x.ts", "[^x].ts"), true);
  assert.equal(matchFile("^.ts", "[^x].ts"), true);
  assert.equal(matchFile("y.ts", "[^x].ts"), false);
});

test("an inverted character range fails with a clear pattern error", () => {
  assert.throws(() => globToRegExp("[z-a].ts"), /Invalid glob pattern/);
});


test("character-class negation via ''!'' matches the complement", () => {
  // Glob negation is "!"; [!a] must match anything except "a" (not "a" or "^").
  assert.equal(matchFile("b.ts", "[!a].ts"), true);
  assert.equal(matchFile("a.ts", "[!a].ts"), false);
  assert.equal(matchFile("^.ts", "[!a].ts"), true);
  assert.equal(matchFile("d.ts", "[!a-c].ts"), true);
  assert.equal(matchFile("b.ts", "[!a-c].ts"), false);
});

test("`**/` matches whole segments only — no partial-name false positives", () => {
  // Regression: `**/` used to compile to a bare `.*` that also swallowed the
  // following separator, so "**/host.ts" matched "node-host.ts" — the `.*`
  // happily ate "src/host/node-". A `**` path segment must align to segment
  // boundaries (or match zero segments); only a bare trailing `**` may end
  // mid-segment.
  assert.equal(matchFile("src/host/host.ts", "**/host.ts"), true);
  assert.equal(matchFile("host.ts", "**/host.ts"), true, "`**/` matches zero leading segments");
  assert.equal(matchFile("src/host/node-host.ts", "**/host.ts"), false);
  assert.equal(matchFile("xhost.ts", "**/host.ts"), false);
  assert.equal(globToRegExp("**/host.ts").test("src/host/node-host.ts"), false);
  assert.equal(globToRegExp("**/host.ts").test("src/host/host.ts"), true);
});
