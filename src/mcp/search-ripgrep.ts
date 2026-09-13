import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LineRef {
  line: number;
  text: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  context_before?: LineRef[];
  context_after?: LineRef[];
}

/** True when a usable ripgrep binary is on PATH. */
export async function ripgrepAvailable(executable = "rg"): Promise<boolean> {
  try {
    await execFileAsync(executable, ["--version"], { windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function toRgGlob(pattern: string): string {
  const p = pattern.replace(/\\/g, "/");
  return p.includes("/") ? p : `**/${p}`;
}

export function normalizeRgPath(p: string): string {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Build context line references for a 0-based hit index into `lines`.
 * Shared by the ripgrep path and the built-in fallback walk.
 */
export function buildContext(
  lines: string[],
  hitIndex: number,
  contextLines: number,
): { context_before: LineRef[]; context_after: LineRef[] } {
  const n = Math.max(0, Math.floor(contextLines));
  const context_before: LineRef[] = [];
  const context_after: LineRef[] = [];
  for (let i = Math.max(0, hitIndex - n); i < hitIndex; i++) {
    context_before.push({ line: i + 1, text: lines[i] ?? "" });
  }
  for (let i = hitIndex + 1; i <= Math.min(lines.length - 1, hitIndex + n); i++) {
    context_after.push({ line: i + 1, text: lines[i] ?? "" });
  }
  return { context_before, context_after };
}

export interface RipgrepOptions {
  query: string;
  cwd: string;
  regex?: boolean;
  includeGlobs?: string[];
  maxResults?: number;
  contextLines?: number;
  executable?: string;
}

/**
 * Run ripgrep and return matches (with optional context). rg handles .gitignore
 * and skips .git by default; node_modules is explicitly excluded.
 */
/** Minimal shape of a ripgrep --json event line (match/context records). */
type RgEvent = {
  type?: unknown;
  data?: {
    path?: { text?: unknown };
    line_number?: unknown;
    lines?: { text?: unknown };
  };
};

export async function runRipgrep(opts: RipgrepOptions): Promise<{ matches: SearchMatch[]; partial: boolean }> {
  const exe = opts.executable ?? "rg";
  const contextLines = Math.max(0, Math.floor(opts.contextLines ?? 0));
  // Cap tripped mid-run: the child is killed as soon as this many matches have
  // been collected so a page-sized search on a huge repo does not scan (and
  // buffer) the whole tree — previously the cap was only applied after rg had
  // run to completion, so broad queries blew up memory and hit the 60 s
  // timeout instead of returning the first page.
  const cap = opts.maxResults && opts.maxResults > 0 ? opts.maxResults : undefined;
  const args = [
    "--json", "--line-number", "--no-heading", "--color", "never",
    // Search hidden files too so results match the built-in fallback walk
    // (which only skips .git/node_modules/dist); ripgrep skips hidden files by
    // default, silently hiding dotfiles/.github from search_files.
    "--hidden",
    "--glob", "!**/.git/**", "--glob", "!**/node_modules/**", "--glob", "!**/dist/**",
  ];
  if (!opts.regex) args.push("--fixed-strings");
  if (contextLines > 0) args.push("--context", String(contextLines));
  for (const g of opts.includeGlobs ?? []) {
    args.push("--glob", toRgGlob(g));
  }
  args.push("--", opts.query, ".");

  const perFile = new Map<string, { contextLines: Map<number, string>; matches: Array<{ line: number; text: string }> }>();
  const child = spawn(exe, args, { cwd: opts.cwd, windowsHide: true });
  let totalMatches = 0;
  let cappedEarly = false;
  const stopAtCap = (): void => {
    if (!cap || cappedEarly || totalMatches < cap) return;
    cappedEarly = true;
    try { child.kill(); } catch { /* already gone */ }
  };
  const handleEventLine = (line: string): void => {
    if (!line.trim()) return;
    let event: RgEvent;
    try {
      event = JSON.parse(line) as RgEvent;
    } catch {
      return;
    }
    if ((event.type === "match" || event.type === "context") && event.data?.path?.text && typeof event.data?.line_number === "number") {
      const p = normalizeRgPath(String(event.data.path.text));
      const entry = perFile.get(p) ?? { contextLines: new Map<number, string>(), matches: [] };
      const text = String(event.data.lines?.text ?? "").replace(/\r?\n$/, "");
      if (event.type === "context") {
        entry.contextLines.set(event.data.line_number, text);
      } else {
        entry.matches.push({ line: event.data.line_number, text });
        totalMatches += 1;
        stopAtCap();
      }
      perFile.set(p, entry);
    }
  };

  let pending = "";
  // rg exit code 2 means "error occurred while searching" (e.g. unreadable
  // files): results collected so far are real but INCOMPLETE — surfaced as
  // `partial` instead of being silently treated as the full answer.
  let exitCode: number | null = 0;
  const failure = await new Promise<Error | undefined>(resolve => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("ripgrep timed out after 60000 ms."));
    }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      pending += chunk;
      let idx: number;
      while ((idx = pending.indexOf("\n")) !== -1) {
        handleEventLine(pending.slice(0, idx));
        pending = pending.slice(idx + 1);
      }
    });
    child.stderr.on("data", () => { /* diagnostics only; failure surfaces via close/error */ });
    child.on("error", error => finish(error instanceof Error ? error : new Error(String(error))));
    child.on("close", code => {
      exitCode = code;
      finish();
    });
  });
  if (failure) throw failure;
  handleEventLine(pending); // trailing line without a final newline

  const results: SearchMatch[] = [];
  for (const [p, entry] of perFile) {
    for (const m of entry.matches) {
      const item: SearchMatch = { path: p, line: m.line, text: m.text };
      if (contextLines > 0) {
        const before: LineRef[] = [];
        const after: LineRef[] = [];
        for (let ln = Math.max(1, m.line - contextLines); ln < m.line; ln++) {
          if (entry.contextLines.has(ln)) before.push({ line: ln, text: entry.contextLines.get(ln)! });
        }
        for (let ln = m.line + 1; ln <= m.line + contextLines; ln++) {
          if (entry.contextLines.has(ln)) after.push({ line: ln, text: entry.contextLines.get(ln)! });
        }
        item.context_before = before;
        item.context_after = after;
      }
      results.push(item);
      if (cap && results.length >= cap) break;
    }
    if (cap && results.length >= cap) break;
  }
  // An intentional early stop at the cap hides whether rg would have exited 2;
  // only report `partial` for full runs.
  return { matches: results, partial: !cappedEarly && exitCode === 2 };
}
