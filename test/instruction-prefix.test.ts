/**
 * The connect-time prefix must be byte-stable, and its reported size must be
 * the size that actually goes out.
 *
 * Why this is a test and not a comment: `instructions` and `tools/list` are the
 * prompt prefix every provider caches *by byte*. A catalog whose order came from
 * an unordered collection, or an instruction string that picked up a timestamp,
 * would still pass every functional test in this repository — nothing would
 * break, every client's cache would just quietly start missing on every request.
 * The reference incident is a Go agent framework that embedded a map-iteration
 * order into one tool's description and dropped its cache hit rate to 2.7%.
 *
 * So the invariants pinned here are the two that no behaviour test can see:
 * repeated assembly is byte-identical, and `measurePrefix()` reports the same
 * bytes the wire carries.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setHost, type Host } from "../src/host/host.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";
import { listToolDefinitions } from "../src/bridge/tool-catalog.js";
import {
  SERVER_INSTRUCTIONS_BASE,
  measurePrefix,
  serverInstructions,
} from "../src/bridge/instruction-prefix.js";

let dir: string;

/** Config returns the caller's default, so the profile under test is "full". */
function fixtureHost(root: string): Host {
  return {
    config: {
      get: <T>(...args: [string, T]): T => args[1],
      update: async (): Promise<void> => undefined,
    },
    secrets: {
      get: async (): Promise<string | undefined> => undefined,
      store: async (): Promise<void> => undefined,
    },
    state: {
      get: <T>(_key: string, fallback: T): T => fallback,
      update: async (): Promise<void> => undefined,
    },
    storageDir: () => "",
    version: () => "test",
    bundledRipgrep: () => undefined,
    projectRoot: () => root,
    notify: (): void => undefined,
    log: (): void => undefined,
    ui: { update: (): void => undefined, refresh: (): void => undefined },
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ob-prefix-"));
  setHost(fixtureHost(dir));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("the catalog serializes byte-identically across repeated calls", () => {
  const first = JSON.stringify(listToolDefinitions());
  const second = JSON.stringify(listToolDefinitions());
  const third = JSON.stringify(listToolDefinitions());

  assert.equal(second, first, "a second tools/list must not differ by one byte");
  assert.equal(third, first, "nor a third");
  assert.ok(first.length > 0, "the catalog is not empty");
});

test("catalog order and length follow the definition literal, not a collection", () => {
  const advertised = listToolDefinitions().map(tool => tool.name);

  // TOOL_DEFINITIONS is an `as const` array, so its order is the source of
  // truth. Anything that rebuilt the catalog from an object's keys or a Set
  // would still contain every name — in an order that could move.
  assert.deepEqual(advertised, TOOL_DEFINITIONS.map(tool => tool.name));
});

test("annotations are added and never overwrite a definition field", () => {
  const advertised = listToolDefinitions();

  for (const tool of advertised) {
    const definition = TOOL_DEFINITIONS.find(entry => entry.name === tool.name);
    assert.ok(definition, `${tool.name} comes from the definition literal`);
    for (const [key, value] of Object.entries(definition)) {
      assert.deepEqual(
        (tool as Record<string, unknown>)[key],
        value,
        `${tool.name}.${key} is the definition's own value`,
      );
    }
  }
});

test("the instruction string is byte-identical across repeated assembly", () => {
  const first = serverInstructions();
  const second = serverInstructions();

  assert.equal(second, first, "two connects must be handed the same bytes");
  assert.ok(first.startsWith(SERVER_INSTRUCTIONS_BASE), "the constant base leads");
});

test("operator-editable content is appended after the constant base", () => {
  // AGENTS.md is the part the operator edits mid-session, so it belongs at the
  // tail: an edit then invalidates what follows it rather than reshuffling the
  // constant guidance every client has already cached.
  const marker = "本项目使用中文提交说明。";
  writeFileSync(path.join(dir, "AGENTS.md"), `# 约定\n${marker}\n`, "utf8");
  setHost(fixtureHost(dir));

  const instructions = serverInstructions();
  const projectAt = instructions.indexOf(marker);

  assert.ok(projectAt > 0, "AGENTS.md content is injected");
  assert.ok(
    projectAt >= SERVER_INSTRUCTIONS_BASE.length,
    "project instructions sit after the base, never inside or before it",
  );
});

test("measurePrefix reports exactly the bytes that go out", () => {
  writeFileSync(path.join(dir, "AGENTS.md"), "# 约定\n中文内容占更多字节。\n", "utf8");
  setHost(fixtureHost(dir));

  const measured = measurePrefix();

  assert.equal(measured.instructions_bytes, Buffer.byteLength(serverInstructions(), "utf8"));
  assert.equal(measured.catalog_bytes, Buffer.byteLength(JSON.stringify(listToolDefinitions()), "utf8"));
  assert.ok(Number.isFinite(measured.instructions_bytes) && measured.instructions_bytes > 0);
  assert.ok(Number.isFinite(measured.catalog_bytes) && measured.catalog_bytes > 0);
  // CJK is the reason this is bytes and not characters: the same guidance costs
  // roughly three times as much in UTF-8, and a character count would hide that.
  assert.ok(
    measured.instructions_bytes > serverInstructions().length,
    "a CJK-bearing prefix reports more bytes than characters",
  );
});

test("measurement survives an unreadable workspace instead of throwing", () => {
  // bridge_status is a status surface: a measurement that could throw would take
  // it down, and "I could not measure" must not become "the Bridge is broken".
  setHost(fixtureHost(path.join(dir, "does-not-exist")));

  const measured = measurePrefix();

  assert.ok(Number.isFinite(measured.instructions_bytes));
  assert.ok(Number.isFinite(measured.catalog_bytes));
  assert.ok(measured.catalog_bytes > 0, "the catalog does not depend on the workspace");
});
