import { existsSync } from "node:fs";
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
  pathEnv: string;
  pathExt: string;
  env: Record<string, string | undefined>;
}

export function resolveDetectEnv(given: DetectEnv = {}): ResolvedEnv {
  const env = given.env ?? process.env;
  return {
    platform: given.platform ?? process.platform,
    exists: given.exists ?? existsSync,
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
 * installed. Returns the resolved absolute file, because a picker that shows
 * a bare name cannot tell the operator WHICH ngrok it is about to run.
 */
export function findOnPath(name: string, given: DetectEnv = {}): string | undefined {
  const { platform, exists, pathEnv, pathExt } = resolveDetectEnv(given);
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
      if (exists(candidate)) return candidate;
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
  const exists = probe ? resolveDetectEnv(probe).exists : undefined;
  const seen = new Set<string>();
  const choices: ExecutableChoice[] = [];
  for (const candidate of candidates) {
    const value = candidate.value?.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (exists && !exists(value)) continue;
    choices.push({ value, label: candidate.label, available: true });
  }
  return choices;
}
