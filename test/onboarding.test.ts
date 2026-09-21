import assert from "node:assert/strict";
import test from "node:test";
import { buildWebAiPrompt } from "../src/bridge/onboarding.js";

const PUBLIC_URL = "https://tunnel.example.dev/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LOCAL_URL = "http://127.0.0.1:18080/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** The two fixed sentences the prompt must end with, verbatim. */
const INSTRUCTION =
  "快速连接这个 MCP（URL），明确使用规则，熟悉可用工具，做好处理接下来一系列工作的准备。";
const TODO_NOTE =
  "多步工作一开始就用 set_todos 写下完整清单，推进时整表替换（操作者的 TUI 任务面板只显示这份清单）；瞬时进度用 report_progress，不能代替清单。";
const TRANSPORT_NOTE =
  "若遇到传输层报错（SSL EOF、连接被重置或超时），等 5 秒后重试一次；这不是工具失败。";
const CAVEAT =
  "⚠️ 当前未开启隧道：下面的地址只有本机能访问，外部 AI 客户端（网页版等）连不上。"
  + "要发给外部客户端，请先在控制台「设置」页填写 ngrokDomain 并开启隧道，然后重新复制本提示词。";
const AUTH_NOTE =
  "\n\n注意：本 Bridge 已启用 Bearer 门禁。除上面的 URL 外，请求还需带上请求头 "
  + "`Authorization: Bearer <token>`（令牌在 Open Bridge Web 控制台签发，"
  + "只在签发时显示一次）。若你的客户端只能填 URL、不能设置请求头，可改用 `?token=<token>` 形式。";

// Exact equality for every variant, not substring checks. The defect this
// replaced emitted `…明确使用规则，"<newline><newline>    + "熟悉可用工具…`,
// which compiled fine (one legal template literal) and passed the old
// assertions — they only looked at a prefix of the sentence. Only reading the
// live /api/prompt output caught it. Whole-string assertions are what turn that
// class of mistake into a failing test.

test("a public URL needs no caveat", () => {
  assert.equal(
    buildWebAiPrompt({ url: PUBLIC_URL, isPublic: true, authEnabled: false }),
    `【${PUBLIC_URL}】\n\n${INSTRUCTION}\n${TODO_NOTE}\n${TRANSPORT_NOTE}`,
  );
});

test("a loopback URL leads with the caveat and the way to publish it", () => {
  assert.equal(
    buildWebAiPrompt({ url: LOCAL_URL, isPublic: false, authEnabled: false }),
    `${CAVEAT}\n\n【${LOCAL_URL}】\n\n${INSTRUCTION}\n${TODO_NOTE}\n${TRANSPORT_NOTE}`,
  );
});

test("the bearer note is added when the gate is on, in both variants", () => {
  assert.equal(
    buildWebAiPrompt({ url: PUBLIC_URL, isPublic: true, authEnabled: true }),
    `【${PUBLIC_URL}】${AUTH_NOTE}\n\n${INSTRUCTION}\n${TODO_NOTE}\n${TRANSPORT_NOTE}`,
  );
  assert.equal(
    buildWebAiPrompt({ url: LOCAL_URL, isPublic: false, authEnabled: true }),
    `${CAVEAT}\n\n【${LOCAL_URL}】${AUTH_NOTE}\n\n${INSTRUCTION}\n${TODO_NOTE}\n${TRANSPORT_NOTE}`,
  );
});

test("no source artifacts survive into the text", () => {
  for (const isPublic of [true, false]) {
    for (const authEnabled of [true, false]) {
      const prompt = buildWebAiPrompt({ url: LOCAL_URL, isPublic, authEnabled });
      assert.equal(prompt.split(LOCAL_URL).length - 1, 1, "exactly one URL");
      assert.ok(prompt.endsWith(TRANSPORT_NOTE), "the retry note is the literal tail");
      assert.ok(prompt.includes(INSTRUCTION), "the instruction is intact");
      assert.ok(prompt.includes(TODO_NOTE), "set_todos is in the paste prompt");
      assert.ok(prompt.includes("set_todos"), "the tool name is explicit");
      assert.ok(!prompt.includes('"\n'), "a quoted newline leaked from a botched literal");
      assert.ok(!/\n\s*\+\s/.test(prompt), "a leftover concatenation operator leaked");
    }
  }
});
