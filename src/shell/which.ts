import { existsSync, lstatSync } from "node:fs";
import * as path from "node:path";

/**
 * Locating executables the operator should not have to locate themselves.
 *
 * Two settings used to be a bare text box each — shellPath and ngrokExecutable
 * — with a placeholder explaining what to type. That is fine if you already
 * know where Git Bash installed itself; it is a dead end if you do not, and
 * the failure arrives much later as a spawn ENOENT buried in a log line. The
 * machine can answer both questions, so it does, and the console offers what
 * it found as a list to pick from.
 */
export interface ExecutableChoice {
  /** Exactly what gets stored in config: a full path, or "" meaning auto. */
  value: string;
  /** Human name for the picker — "Git Bash", not the path a second time. */
  label: string;
  /** Present on this machine right now (a stale config entry shows as false). */
  available: boolean;
}

/** Injected in tests so detection results do not depend on the test machine. */
export interface DetectEnv {
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
  /**
   * Entry-shaped probe, injected in tests alongside `exists`. On Windows the
   * difference it makes is the whole Store story: an App Execution Alias is a
   * reparse point `stat` cannot follow but CreateProcess can.
   */
  lstat?: (file: string) => { isSymbolicLink(): boolean } | null;
  /** Raw PATH string; defaults to this process's. */
  pathEnv?: string;
  /** Raw PATHEXT (Windows); defaults to this process's, then a sane list. */
  pathExt?: string;
  /** Extra lookups (HOME, LOCALAPPDATA, ...) resolved from the environment. */
  env?: Record<string, string | undefined>;
}


interface ResolvedEnv {
  platform: NodeJS.Platform;
  exists: (file: string) => boolean;
  lstat: (file: string) => { isSymbolicLink(): boolean } | null;
  pathEnv: string;
  pathExt: string;
  env: Record<string, string | undefined>;
}

/** `lstat`, but a missing entry answers null instead of throwing. */
export function lstatOrNull(file: string): { isSymbolicLink(): boolean } | null {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

/**
 * Is this path a program the OS would actually run?
 *
 * `existsSync` is the obvious answer and it is wrong for one common case: an
 * app installed from the Microsoft Store reaches PATH as an *App Execution
 * Alias*. `%LOCALAPPDATA%\Microsoft\WindowsApps\ngrok.exe` is a 78-byte
 * reparse point that CreateProcess resolves at spawn time, so `stat` — and with
 * it `existsSync` — fails on the file the operator's own terminal runs every
 * day. The alias exists only because the app is installed, so a Windows
 * reparse point counts as present. Everywhere else the strict rule stands: a
 * dangling symlink is not a program.
 */
export function executableExists(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (existsSync(file)) return true;
  return platform === "win32" && (lstatOrNull(file)?.isSymbolicLink() ?? false);
}

/** Would the OS resolve this PATH entry? `executableExists` explains the alias. */
function present(resolved: ResolvedEnv, file: string): boolean {
  if (resolved.exists(file)) return true;
  return resolved.platform === "win32" && (resolved.lstat(file)?.isSymbolicLink() ?? false);
}

/** The Store's alias directory: a hit here means the app came from the Store. */
export function isWindowsStoreAlias(file: string): boolean {
  return /[\\/]microsoft[\\/]windowsapps[\\/]/i.test(file);
}

export function resolveDetectEnv(given: DetectEnv = {}): ResolvedEnv {
  const env = given.env ?? process.env;
  const platform = given.platform ?? process.platform;
  return {
    platform,
    exists: given.exists ?? ((file: string) => executableExists(file, platform)),
    lstat: given.lstat ?? lstatOrNull,
    pathEnv: given.pathEnv ?? env.PATH ?? env.Path ?? "",
    pathExt: given.pathExt ?? env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    env,
  };
}

/**
 * The first directory on PATH holding `name`, or undefined.
 *
 * Windows needs PATHEXT applied: "ngrok" on PATH is really ngrok.exe, and a
 * plain existsSync("...\\ngrok") answers false for a binary that is very much
 * installed. A Store install needs one more step on top of PATHEXT — the
 * found file is an alias, see `present` — and both are why the check here is
 * not a bare existsSync. Returns the resolved absolute file, because a picker
 * that shows a bare name cannot tell the operator WHICH ngrok it runs.
 */
export function findOnPath(name: string, given: DetectEnv = {}): string | undefined {
  const resolved = resolveDetectEnv(given);
  const { platform, pathEnv, pathExt } = resolved;
  const separator = platform === "win32" ? ";" : ":";
  // Join with the TARGET platform's rules, not the running one's. They are the
  // same in production, and different under test — a Windows runner exercising
  // the POSIX branch would otherwise build "\\usr\\bin\\bash" and find nothing.
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  // PATHEXT is conventionally UPPERCASE. Windows does not care, but this path
  // is shown in a dropdown, and "ngrok.EXE" reads like a mistake.
  const extensions = platform === "win32" && !path.win32.extname(name)
    ? pathExt.split(";").map(item => item.trim().toLowerCase()).filter(Boolean)
    : [""];
  for (const rawDir of pathEnv.split(separator)) {
    // PATH entries are quoted surprisingly often on Windows, and an empty
    // entry (a stray ";") means the current directory, which is not a place to
    // go looking for a system shell.
    const dir = rawDir.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (present(resolved, candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Collapse a candidate list to the ones that exist, keeping the declared order
 * (which is a preference order) and dropping duplicates — PATH and a known
 * install directory routinely point at the same binary.
 *
 * Pass `probe` when the candidates are guesses at fixed install locations:
 * each one is then confirmed on disk before it reaches the picker, because a
 * dropdown offering a path that is not there is worse than an empty dropdown.
 * Callers that already resolved their candidates (via findOnPath, or a name
 * the OS guarantees) omit it.
 */
export function availableChoices(
  candidates: readonly { value: string | undefined; label: string }[],
  probe?: DetectEnv,
): ExecutableChoice[] {
  const resolved = probe ? resolveDetectEnv(probe) : undefined;
  const seen = new Set<string>();
  const choices: ExecutableChoice[] = [];
  for (const candidate of candidates) {
    const value = candidate.value?.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (resolved && !present(resolved, value)) continue;
    choices.push({ value, label: candidate.label, available: true });
  }
  return choices;
}
