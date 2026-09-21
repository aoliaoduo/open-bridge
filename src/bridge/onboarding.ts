/**
 * The onboarding text the console copies for an AI client ("接入提示词").
 *
 * Pure by design: the caller supplies what the instance knows — its MCP URL,
 * whether that URL is reachable from outside, and whether the bearer gate is
 * on — so every variant is unit-testable without a running bridge.
 *
 * The loopback variant MUST say that it is loopback. The prompt exists to be
 * pasted into a client that is often not on this machine (a browser AI, a
 * hosted client), and a silent `127.0.0.1` is a dead end for exactly those
 * clients — the old text handed one over with no comment at all, while the
 * console card next to the button was careful to say "仅本机可访问".
 *
 * The fixed text is deliberately minimal. The URL goes out bare — the 【】
 * wrapper is gone, so anything that auto-links or pastes the first line
 * verbatim gets a clean address — and the working details are left to the
 * server instructions the client reads at connect time. The one duty that
 * cannot move there is the todo panel: a web AI that never calls set_todos
 * leaves the operator's TUI task panel stuck on a previous session, so the
 * prompt still says it in so many words.
 */

export interface WebAiPromptInputs {
  /** The MCP URL to advertise: the public tunnel URL when one is live. */
  url: string;
  /** True only while a tunnel is published; false means the URL is loopback. */
  isPublic: boolean;
  /** Whether requests must also carry a bearer token. */
  authEnabled: boolean;
}

export function buildWebAiPrompt(inputs: WebAiPromptInputs): string {
  // The prompt carries the credential, so it must mention the second one when
  // the bearer gate is on; otherwise the client gets a 401 with no explanation.
  const authNote = inputs.authEnabled
    ? "\n\n注意：本 Bridge 已启用 Bearer 门禁。除上面的 URL 外，请求还需带上请求头 "
      + "`Authorization: Bearer <token>`（令牌在 Open Bridge Web 控制台签发，"
      + "只在签发时显示一次）。若你的客户端只能填 URL、不能设置请求头，可改用 `?token=<token>` 形式。"
    : "";
  const localNote = inputs.isPublic
    ? ""
    : "⚠️ 当前未开启隧道：下面的地址只有本机能访问，外部 AI 客户端（网页版等）连不上。"
      + "要发给外部客户端，请先在控制台「设置」页填写 ngrokDomain 并开启隧道，然后重新复制本提示词。\n\n";
  // Plain strings for the fixed tail: a template literal that spans lines can
  // silently swallow its own continuation, and tsc has nothing to complain about.
  const instruction = "连接这个 MCP（URL），阅读服务器说明，明确规则与工具后待命接受任务。";
  // The todo-panel duty stays in the paste text even though the other working
  // details moved to the server instructions: a client that skips those would
  // otherwise leave the operator's TUI panel stuck on a stale session.
  const workingNotes = "多步工作先以 set_todos 写清单、整表替换，瞬时进度用 report_progress；"
    + "传输层报错（SSL EOF、连接被重置或超时）等 5 秒重试一次，那不算工具失败。";
  return `${localNote}${inputs.url}${authNote}\n\n${instruction}\n${workingNotes}`;
}
