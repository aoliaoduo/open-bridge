import { shellDialect } from "./shell-args.js";
import type { ShellSpec } from "./shell-provider.js";

const COACHING: Record<ReturnType<typeof shellDialect>, string> = {
  posix:
    "write POSIX shell syntax (`ls`, `grep`, `&&`, `2>/dev/null`) — cmd/PowerShell idioms (`nul`, `%VAR%`, `findstr`) do not exist there",
  powershell:
    "write PowerShell syntax (`$env:VAR`, `;` to chain) — POSIX-only idioms like `2>/dev/null` do not exist there",
};

/**
 * The one environment fact a connecting model cannot infer for itself: WHICH
 * program interprets the command text of run_command / start_process /
 * open_shell, and so which dialect to write. The same resolveShell() result
 * drives the actual spawn, so this line cannot drift from what runs; the
 * alternative to reading one sentence is guessing — and a wrong guess does
 * not error, it mis-guards (`2>nul` under bash creates a file named `nul`).
 */
export function shellUsageInstructions(spec: ShellSpec): string {
  return ` Commands typed into \`run_command\`, \`start_process\` and \`open_shell\` are interpreted by \`${spec.file}\` (\`${spec.args.join(" ")}\`): ${COACHING[shellDialect(spec.file)]}.`;
}
