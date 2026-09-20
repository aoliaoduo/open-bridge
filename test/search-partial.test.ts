import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setHost, type Host } from "../src/host/host.js";
import { searchFiles } from "../src/bridge/file-tools.js";

const dir = mkdtempSync(path.join(tmpdir(), "ob-search-partial-"));
const fakeRg = path.join(dir, "fake-rg");
const canExecuteFakeRipgrep = process.platform !== "win32";

if (canExecuteFakeRipgrep) {
  writeFileSync(fakeRg, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("ripgrep 14.0.0");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: "match", data: {
  path: { text: "visible.txt" }, line_number: 1, lines: { text: "needle\\n" },
} }) + "\\n");
process.stderr.write("simulated unreadable path\\n");
process.exit(2);
`, "utf8");
  chmodSync(fakeRg, 0o755);
  writeFileSync(path.join(dir, "visible.txt"), "needle\n", "utf8");
}

function memoryHost(): Host {
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
    bundledRipgrep: () => canExecuteFakeRipgrep ? fakeRg : undefined,
    projectRoot: () => dir,
    notify: (): void => undefined,
    log: (): void => undefined,
    ui: { update: (): void => undefined, refresh: (): void => undefined },
  };
}

setHost(memoryHost());

after(() => rmSync(dir, { recursive: true, force: true }));

test("search_files exposes ripgrep partial completion separately from pagination", { skip: !canExecuteFakeRipgrep }, async () => {
  const result = await searchFiles({ query: "needle", max_results: 10 }) as {
    items: Array<{ path: string; line: number; text: string }>;
    truncated: boolean;
    next_offset: number | null;
    partial: boolean;
  };

  assert.deepEqual(result.items, [{ path: "visible.txt", line: 1, text: "needle" }]);
  assert.equal(result.truncated, false, "the collected page itself has no continuation");
  assert.equal(result.next_offset, null);
  assert.equal(result.partial, true,
    "exit 2 after real matches must not be published as a complete search");
});
