import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  activityHint,
  buildActivityPresentationHint,
  clearActivityHints,
  rememberActivityHint,
} from "../src/bridge/activity-presentation.js";

afterEach(() => clearActivityHints());

test("structured activity hints preserve action, subject and scope before serialization", () => {
  assert.deepEqual(buildActivityPresentationHint("search_files", { query: "needle", path: "src" }), {
    action: "搜索", subject: "needle", qualifier: "src", subjectKind: "query", qualifierKind: "path",
  });
  assert.deepEqual(buildActivityPresentationHint("edit_block", {
    path: "src/app.ts",
    edits: [{ old_text: "a", new_text: "b" }, { old_text: "c", new_text: "d" }],
  }), { action: "修改", subject: "src/app.ts", qualifier: "2 处修改", subjectKind: "path" });
  assert.deepEqual(buildActivityPresentationHint("run_command", {
    command: "git status -sb && git log -1 --oneline",
  }), { action: "命令", subject: "git status -sb", subjectKind: "command" });
});

test("structured hints redact selected text before it reaches the TUI-only cache", () => {
  const redact = (text: string) => text.replace(/secret/gi, "<redacted>");
  assert.equal(buildActivityPresentationHint("notify", { message: "secret payload" }, redact)?.subject, "<redacted> payload");
  assert.deepEqual(buildActivityPresentationHint(
    "set_config_value",
    { key: "notifications.barkKey", value: "<set:22 chars>" },
    redact,
  ), { action: "配置", subject: "notifications.barkKey", qualifier: "<set:22 chars>", subjectKind: "generic" });
});

test("the process-local hint cache is bounded, copied, and clearable", () => {
  for (let i = 0; i < 300; i += 1) {
    rememberActivityHint(`id-${i}`, { action: "测试", subject: `hint-${i}`, subjectKind: "generic" });
  }
  assert.equal(activityHint("id-0"), undefined, "old hints are evicted instead of growing forever");
  const latest = activityHint("id-299");
  assert.equal(latest?.subject, "hint-299");
  if (latest) latest.subject = "caller mutation";
  assert.equal(activityHint("id-299")?.subject, "hint-299", "callers cannot mutate the cached hint");
  clearActivityHints();
  assert.equal(activityHint("id-299"), undefined);
});
