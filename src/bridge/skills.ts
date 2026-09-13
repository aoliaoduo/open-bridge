/**
 * Skill discovery: the `SKILL.md` convention, read-only.
 *
 * A "skill" here is a folder holding a `SKILL.md` file — front matter with a
 * `name` and a `description`, then the procedure itself in markdown. Taken from
 * the reference projects (DevSpace / TaskQuay keep their skills in
 * `skills/<name>/SKILL.md` and load them with a coding-agent runtime); what we
 * take is the *convention* and the *index*, not their dependency: this module
 * reads markdown and nothing else.
 *
 * Two deliberate properties:
 *
 *  - **Read-only.** Discovery never creates a directory, never writes a managed
 *    skill into someone's tree, and never rewrites a file. Their loader syncs a
 *    bundled skill into the config dir; ours only looks.
 *  - **Index first, contents on demand.** Only the name, description and path
 *    travel in the server instructions; the body stays on disk until a model
 *    decides the task matches and reads it with `read_files`. That keeps the
 *    context cost of ten skills equal to that of one.
 *
 * Lookup order is workspace-first, so a project can shadow a user-level skill of
 * the same name; the shadow count is reported instead of silently dropping the
 * loser. Everything is bounded (skill count, description length, bytes parsed)
 * because this runs on the request path.
 */

import * as fsSync from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { host } from "../host/host.js";
import { root } from "./paths.js";

export interface Skill {
  /** Front matter `name`, or the folder name when the file has no front matter. */
  name: string;
  /** Front matter `description`, or the first prose line of the file. */
  description: string;
  /** Absolute path of the SKILL.md itself — exactly what `read_files` needs. */
  path: string;
  /** Its folder: relative to the workspace when inside it, absolute otherwise. */
  dir: string;
  /** Skills from the Open Bridge data directory or `~/.agents` live outside the workspace. */
  outside_workspace: boolean;
}

export interface SkillDiscovery {
  skills: Skill[];
  /** Directories that existed and were scanned (the tool payload shows them). */
  scanned: string[];
  /** Skills skipped because an earlier directory already defined that name. */
  shadowed: number;
}

export const SKILL_FILE = "SKILL.md";
export const MAX_SKILLS = 50;
const MAX_NAME_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 200;
/** Only the head of a SKILL.md is parsed for front matter; the body is not read here. */
const MAX_PARSE_BYTES = 64 * 1024;
/** Instructions stay small: this many entries, then a pointer to `list_skills`. */
const MAX_INDEX_LINES = 20;

/**
 * Where skills come from, in shadowing order: the project's own folders first
 * (the three spellings in the wild), then the user-level ones. Missing
 * directories are simply skipped.
 */
export function skillDirs(rootPath: string, extraDirs: string[] = [], home: string = homedir()): string[] {
  return [
    path.join(rootPath, "skills"),
    path.join(rootPath, ".agents", "skills"),
    path.join(rootPath, ".claude", "skills"),
    ...extraDirs.map(dir => path.join(dir, "skills")),
    path.join(home, ".agents", "skills"),
  ];
}

/** Strip matching surrounding quotes from a front-matter value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed[trimmed.length - 1] === trimmed[0]) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Parse the front matter of a SKILL.md, falling back to the first heading (for
 * the name) and the first prose line (for the description). Tolerates a missing
 * or unterminated front-matter block, CRLF, and unknown keys.
 */
export function parseSkillFile(raw: string, fallbackName: string): { name: string; description: string } {
  const text = raw.replace(/\r\n/g, "\n");
  let name = "";
  let description = "";
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (front) {
    // Every group in both patterns is mandatory, so the `?? ""` fallbacks never
    // fire; they only tell the compiler what the regex already guarantees. An
    // empty string also degrades correctly: it matches neither key.
    for (const line of (front[1] ?? "").split("\n")) {
      const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      const value = unquote(match[2] ?? "");
      if (!value) continue;
      const key = (match[1] ?? "").toLowerCase();
      if (key === "name" && !name) name = value;
      if (key === "description" && !description) description = value;
    }
  }
  const body = front ? text.slice(front[0].length) : text;
  if (!name) {
    const heading = /^#\s+(.+)$/m.exec(body);
    name = heading ? (heading[1] ?? "").trim() : fallbackName;
  }
  if (!description) {
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      // A fence, a heading or a `key: value` line is not prose: the description
      // falls through to the first real sentence.
      if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;
      if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(trimmed)) continue;
      description = trimmed;
      break;
    }
  }
  return {
    name: name.slice(0, MAX_NAME_CHARS),
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
  };
}

/** Read at most MAX_PARSE_BYTES from the head of a file; null when unreadable. */
function readHead(file: string): string | null {
  try {
    const stat = fsSync.statSync(file);
    if (!stat.isFile()) return null;
    const handle = fsSync.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_PARSE_BYTES));
      const read = fsSync.readSync(handle, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, read).toString("utf8");
    } finally {
      fsSync.closeSync(handle);
    }
  } catch {
    return null;
  }
}

/** Scan the skill directories and return the index. Never throws, never writes. */
export function discoverSkills(options: { root: string; extraDirs?: string[]; home?: string }): SkillDiscovery {
  const scanned: string[] = [];
  const skills: Skill[] = [];
  const seen = new Set<string>();
  let shadowed = 0;

  // `home` stays explicit so a caller (and every test) cannot inherit the
  // machine's real ~/.agents/skills by accident.
  for (const dir of skillDirs(options.root, options.extraDirs ?? [], options.home ?? homedir())) {
    if (skills.length >= MAX_SKILLS) break;
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // absent or unreadable: not an error, just nothing to add
    }
    scanned.push(dir);
    // Deterministic order regardless of how the filesystem lists entries.
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (skills.length >= MAX_SKILLS) break;
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name, SKILL_FILE);
      const raw = readHead(file);
      if (raw === null) continue; // no SKILL.md: just a folder
      const parsed = parseSkillFile(raw, entry.name);
      const key = parsed.name.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) {
        shadowed += 1;
        continue;
      }
      seen.add(key);
      const inside = !path.relative(options.root, file).startsWith("..");
      skills.push({
        name: parsed.name,
        description: parsed.description,
        path: file,
        dir: inside ? path.relative(options.root, path.dirname(file)) : path.dirname(file),
        outside_workspace: !inside,
      });
    }
  }
  return { skills, scanned, shadowed };
}

/**
 * The instructions block: what exists, where it is, and the rule that the file
 * itself is the source of truth. Empty when there are no skills — nothing is
 * injected for a workspace that has none.
 */
export function skillsIndexSuffix(skills: Skill[]): string {
  if (!skills.length) return "";
  const shown = skills.slice(0, MAX_INDEX_LINES);
  const lines = shown.map(skill => `- ${skill.name} — ${skill.description} (${skill.path})`);
  const remaining = skills.length - shown.length;
  return "\n\n# Available skills\n"
    + "Skills are folders holding a SKILL.md that describe how work is done here. When a task matches one, "
    + "read that file with read_files and follow it; do not guess its contents. Call list_skills to refresh "
    + "this list (for example after a skill is added mid-session).\n"
    + lines.join("\n")
    + (remaining > 0 ? `\n- …and ${remaining} more (call list_skills)` : "");
}

/** Real-world wiring: the workspace root plus the Open Bridge data directory. */
export function discoverWorkspaceSkills(): SkillDiscovery {
  return discoverSkills({ root: root(), extraDirs: [host().storageDir()] });
}

/**
 * The `list_skills` tool result. Deliberately contents-free: the description and
 * the path are enough for a model to decide, and reading remains an explicit
 * `read_files` call with the normal file-access rules.
 */
export function listSkills(): Record<string, unknown> {
  const discovery = discoverWorkspaceSkills();
  return {
    count: discovery.skills.length,
    skills: discovery.skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      path: skill.path,
      dir: skill.dir,
      outside_workspace: skill.outside_workspace,
    })),
    scanned_dirs: discovery.scanned,
    shadowed: discovery.shadowed,
    note: "Read a matching skill's SKILL.md with read_files before following it; this list is re-read from disk on every call.",
  };
}
