import assert from "node:assert/strict";
import test from "node:test";
import { buildWebAiPrompt } from "../src/bridge/onboarding.js";

const WORKING_NOTES =
  "多步工作先以 set_todos 写清单、整表替换，瞬时进度用 report_progress；"
  + "传输层报错（SSL EOF、连接被重置或超时）等 5 秒重试一次，那不算工具失败。";

test("the setup prompt contains operating instructions only, never connection details", () => {
  const prompt = buildWebAiPrompt();
  assert.equal(
    prompt,
    `连接这个 MCP，阅读服务器说明，明确规则与工具后待命接受任务。\n${WORKING_NOTES}`,
  );
  assert.ok(prompt.includes("set_todos"), "the todo-panel instruction stays explicit");
  assert.ok(!prompt.includes("http://"));
  assert.ok(!prompt.includes("https://"));
  assert.ok(!prompt.includes("/mcp/"));
  assert.ok(!prompt.includes("URL"));
  assert.ok(!prompt.includes("Bearer"));
  assert.ok(!prompt.includes("未开启隧道"));
});
