/**
 * CLI surface for the shareable diagnostics report.
 *
 * Collection and classification live in diagnostics-report.ts; Markdown
 * presentation lives in diagnostics-render.ts. This module keeps the original
 * import path stable for the CLI and tests and owns only filesystem delivery.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { fail, type ParsedArgs } from "./args.js";
import { t } from "./cli-i18n.js";
import { buildDiagnosticsReport } from "./diagnostics-report.js";
import { renderDiagnosticsMarkdown } from "./diagnostics-render.js";
import { resolveHome } from "./registry.js";
import { VERSION } from "./version.js";

export { buildDiagnosticsReport } from "./diagnostics-report.js";
export type {
  ArtifactRow,
  ArtifactStatus,
  BehaviorSkeleton,
  DiagnosticsReport,
  Finding,
  Severity,
  TransportFacts,
} from "./diagnostics-model.js";
export { renderDiagnosticsMarkdown } from "./diagnostics-render.js";

/**
 * `open-bridge diagnostics [--out FILE]`
 *
 * Writes the report and prints where it went plus anything worth acting on. The
 * file is the deliverable — it is what gets pasted into an issue — so stdout
 * stays short enough to read standing up.
 *
 * Overwrites rather than appends, and defaults to a fixed name inside the data
 * dir: a diagnostic that accumulated one run per invocation would eventually be
 * the largest file in there, and the one anybody filing an issue actually wants
 * is the newest.
 *
 * Works with no instance running, and installs no host. The artifacts outlive
 * the process that wrote them, and the moment this command is most useful is
 * the moment `serve` will not come up.
 */
export async function cmdDiagnostics(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  try {
    fs.mkdirSync(home, { recursive: true });
  } catch (error) {
    fail(t(`无法访问数据目录 ${home}: ${error instanceof Error ? error.message : String(error)}`,
      `Cannot access the data dir ${home}: ${error instanceof Error ? error.message : String(error)}`));
  }

  const report = buildDiagnosticsReport(home, VERSION);
  const markdown = renderDiagnosticsMarkdown(report);

  const flag = parsed.flags.get("out");
  const target = typeof flag === "string" && flag.trim()
    ? path.resolve(flag.trim())
    : path.join(home, "diagnostics.md");
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, markdown, "utf8");
  } catch (error) {
    fail(t(`写入诊断文件失败 ${target}: ${error instanceof Error ? error.message : String(error)}`,
      `Could not write the diagnostic file ${target}: ${error instanceof Error ? error.message : String(error)}`));
  }

  console.log(`${t("已写入", "Wrote")} ${target} (${String(Buffer.byteLength(markdown, "utf8"))} bytes)`);
  console.log(t(
    "白名单投影：不含审计行原文、参数、工作区路径、命令文本、日志内容与任何密钥，可直接公开。",
    "A whitelist projection: no audit line, argument, workspace path, command text, log content or secret. Safe to publish.",
  ));

  const actionable = report.findings.filter(finding => finding.severity !== "info");
  if (actionable.length === 0) {
    console.log(t("没有越过阈值的发现。", "No finding crossed a threshold."));
    return;
  }
  console.log(t(
    `${String(actionable.length)} 项需要看一眼：`,
    `${String(actionable.length)} worth a look:`,
  ));
  for (const finding of actionable) {
    console.log(`  [${finding.severity === "critical" ? "!!" : " ?"}] ${finding.name}`);
  }
}
