/**
 * The onboarding text copied or printed for an AI client ("接入提示词").
 * Connection credentials deliberately stay separate: the console has a
 * dedicated URL copy control and the CLI has `open-bridge url`.
 */

const WORKING_NOTES = "多步工作先以 set_todos 写清单、整表替换，瞬时进度用 report_progress；"
  + "传输层报错（SSL EOF、连接被重置或超时）等 5 秒重试一次，那不算工具失败。";

/**
 * Text copied by the Web console's 「复制接入提示词」 button.
 *
 * The endpoint is already shown beside that button and has its own dedicated
 * copy action. Keeping the capability URL out of the setup text avoids placing
 * it in chat transcripts or other places where the user only meant to paste
 * operating instructions for an already-connected MCP.
 */
export function buildWebAiPrompt(): string {
  return `连接这个 MCP，阅读服务器说明，明确规则与工具后待命接受任务。\n${WORKING_NOTES}`;
}
