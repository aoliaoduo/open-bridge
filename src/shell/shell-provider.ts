import { host } from "../host/host.js";
import { defaultShellArgs } from "./shell-args.js";
import { availableChoices, findOnPath, resolveDetectEnv, type DetectEnv, type ExecutableChoice } from "./which.js";

export interface ShellSpec {
  file: string;
  args: string[];
}

/**
 * Every shell this machine could run commands through, best first.
 *
 * ONE list, used twice: `resolveShell()` walks it to pick the automatic
 * default, and the settings page shows it as the dropdown. They used to be the
 * same knowledge written in two places — the picker would have listed shells
 * the resolver never chooses — which is exactly the kind of drift nobody
 * notices until a command runs in the wrong shell.
 *
 * Order is preference, and it is a judgement about the commands agents write:
 * Git Bash first because agent-authored commands are overwhelmingly POSIX
 * (`ls`, `grep`, `&&`), then PowerShell 7, then the powershell.exe that ships
 * with Windows and is therefore always there.
 */
export function detectShells(given: DetectEnv = {}): ExecutableChoice[] {
  const { platform, exists, env } = resolveDetectEnv(given);
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const gitBash = `${programFiles}\\Git\\bin\\bash.exe`;
    const pwsh7 = `${programFiles}\\PowerShell\\7\\pwsh.exe`;
    return availableChoices([
      { value: exists(gitBash) ? gitBash : findOnPath("bash", given), label: "Git Bash" },
      { value: exists(pwsh7) ? pwsh7 : findOnPath("pwsh", given), label: "PowerShell 7" },
      // Windows PowerShell is part of the OS. It is listed by name rather than
      // by probed path because that is how it is always invoked, and because a
      // machine without it is a machine with bigger problems.
      { value: findOnPath("powershell", given) ?? "powershell.exe", label: "Windows PowerShell" },
    ]);
  }
  return availableChoices([
    { value: exists("/bin/bash") ? "/bin/bash" : findOnPath("bash", given), label: "bash" },
    { value: exists("/bin/zsh") ? "/bin/zsh" : findOnPath("zsh", given), label: "zsh" },
    { value: exists("/bin/sh") ? "/bin/sh" : findOnPath("sh", given), label: "sh" },
  ]);
}

/**
 * What an empty `shellPath` resolves to. Falls back to a per-platform name
 * rather than throwing: detection returning nothing means the probes all
 * missed, not that the machine has no shell.
 */
export function autoShell(given: DetectEnv = {}): string {
  const [first] = detectShells(given);
  if (first) return first.value;
  return resolveDetectEnv(given).platform === "win32" ? "powershell.exe" : "/bin/bash";
}

/** Resolve the configured shell without changing the caller's command text. */
export function resolveShell(): ShellSpec {
  const cfg = host().config;
  const configured = cfg.get<string>("shellPath", "")?.trim();
  const customArgs = cfg.get<string[]>("shellArgs", []);
  const argsFor = (file: string): string[] => customArgs.length ? customArgs : defaultShellArgs(file);
  // A configured path is obeyed even if detection cannot see it: the operator
  // may be pointing at something this code does not know how to look for, and
  // overruling them would be worse than a spawn error that names the path.
  const file = configured || autoShell();
  return { file, args: argsFor(file) };
}
