import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  activityHint,
  buildActivityHint,
  clearActivityHints,
  rememberActivityHint,
} from "../src/bridge/activity-presentation.js";

afterEach(() => clearActivityHints());

test("structured activity hints preserve the operator-facing semantics without serialization parsing", () => {
  assert.equal(buildActivityHint("search_files", { query: "needle", path: "src" }), "needle");
  assert.equal(buildActivityHint("edit_block", {
    path: "src/app.ts",
    edits: [{ old_text: "a", new_text: "b" }, { old_text: "c", new_text: "d" }],
  }), "src/app.ts (2 处修改)");
  assert.equal(buildActivityHint("service", { action: "start_all", group: "backend" }), "start_all group:backend");
  assert.equal(buildActivityHint("process_control", { action: "terminate", command_id: "cmd-12345678" }), "terminate cmd-1234");
  assert.equal(buildActivityHint("batch", { calls: [{ tool: "a" }, { tool: "b" }], mode: "sequential" }), "2 calls (sequential)");
  assert.equal(buildActivityHint("run_command", { command: "git status -sb && git log -1 --oneline" }), "git status -sb");
});

test("structured hints redact selected text before it reaches the TUI-only cache", () => {
  const redact = (text: string) => text.replace(/secret/gi, "<redacted>");
  assert.equal(buildActivityHint("notify", { message: "secret payload" }, redact), "<redacted> payload");
  assert.equal(buildActivityHint("set_config_value", { key: "notifications.barkKey", value: "<set:22 chars>" }, redact),
    "notifications.barkKey = <set:22 chars>");
});

test("the process-local hint cache is bounded and can be cleared with the activity log", () => {
  for (let i = 0; i < 300; i += 1) rememberActivityHint(`id-${i}`, `hint-${i}`);
  assert.equal(activityHint("id-0"), undefined, "old hints are evicted instead of growing forever");
  assert.equal(activityHint("id-299"), "hint-299");
  clearActivityHints();
  assert.equal(activityHint("id-299"), undefined);
});
