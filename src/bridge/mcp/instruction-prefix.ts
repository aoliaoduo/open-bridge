/**
 * The connect-time instruction prefix, and what it costs.
 *
 * Everything a client receives before it ever calls a tool: the base guidance
 * plus four suffixes assembled in a fixed order. It lives in its own module for
 * two reasons.
 *
 * One: both protocol eras hand out the same string (`mcp-endpoint.ts` builds
 * each era's server from here), so the 2025 and 2026 paths cannot drift on what
 * a client is told.
 *
 * Two: this text and the advertised catalog are the *cached prompt prefix* of
 * every connected client. Providers cache a request prefix by bytes, so two
 * properties that no functional test would ever catch are worth real money:
 *
 *  - **Byte stability.** Anything derived from an unordered collection (object
 *    keys, a directory listing, a set) has to be sorted before it reaches this
 *    string, or the prefix changes between two identical requests and every
 *    client's cache silently misses. The failure is invisible: nothing breaks,
 *    the bill just goes up. `test/instruction-prefix.test.ts` pins it.
 *  - **Bounded size.** The prefix is paid for on every request of every
 *    session, so growth is a recurring cost, not a one-off. `measurePrefix()`
 *    reports it and `bridge_status` exposes it, because a budget nobody can
 *    read is a budget that erodes one well-meaning paragraph at a time.
 *
 * The suffix order is part of the contract: the base is constant, and the
 * content that can change under the operator (which shell was detected, whether
 * Bark is configured, AGENTS.md, which skills exist) is appended after it. An
 * edit to AGENTS.md therefore invalidates the tail rather than reshuffling
 * everything that follows it.
 */
import * as fsSync from "node:fs";
import * as path from "node:path";
import { root } from "../paths.js";
import { discoverWorkspaceSkills, skillsIndexSuffix } from "../tools/skills.js";
import { notifyUsageInstructions, resolveNotifySettings } from "../tools/notify.js";
import { resolveShell } from "../../shell/shell-provider.js";
import { shellUsageInstructions } from "../../shell/shell-usage.js";
import { listToolDefinitions } from "../tools/tool-catalog.js";

export const SERVER_INSTRUCTIONS_BASE =
  "You are connected to a local project workspace through the standalone Open Bridge. Relative paths, default command cwd, and project services always use that workspace. Other directories can be accessed only with explicit absolute paths; never let them change the workspace anchor. When starting work on an unfamiliar project, call workspace_brief once for orientation instead of exploring blindly. Use file tools for project management, run_command/start_process for commands, and wait/interact_with_process/process_control/set_process_policy for supervised long-running services. Use connectivity for readiness and save_service/service/service_status for reusable project orchestration. Related single-purpose tools are grouped behind an action parameter: service{action}, file_op{op}, process_control{action}, bridge_status{section}, activity_log{action}, connectivity{target}; the older per-action names still work and are reported as deprecated. For any multi-step work, call set_todos with the full list before you start and replace it as you go — the operator's TUI task panel shows only this list. Use report_progress for transient status, not as a substitute. Use batch to combine multiple tool calls in a single roundtrip. When a task needs several related calls or a tool result is large, prefer run_script: compose the calls in one JavaScript program and return only what you need. After finishing a batch of related edits, call review_changes so the user can see the full cumulative change set. Tool results are JSON objects with a fixed field set per tool: absent facts are explicit nulls or empty strings, so parse by field name and never by line presence; command tools return merged `output` plus separate `stdout`/`stderr`, and a non-zero exit code is not a call failure. Per-tool detail - limits, edge cases, and which sibling tool to prefer - is in docs/tools.md; read it when a description is not enough.";

/**
 * Which interpreter answers run_command / start_process / open_shell, stated
 * once at connect time: the same resolveShell() the spawner consults, so the
 * sentence and the spawn can never disagree. Same rule as the other suffixes
 * — a detection failure must not keep a session from starting.
 */
function shellSuffix(): string {
  try {
    return shellUsageInstructions(resolveShell());
  } catch {
    return "";
  }
}

/**
 * The live notification guidance — a connect-time snapshot, like skills. Mode
 * flips after connect take effect on the server side immediately (the gate
 * reads config per push); the suffix is coaching, not contract. Discovery
 * failure must not keep a session from starting, same rule as the skills index.
 */
function notifySuffix(): string {
  try {
    return notifyUsageInstructions(resolveNotifySettings());
  } catch {
    return "";
  }
}

/** Bounded root project files, appended after the constant base. */
function projectInstructionSuffix(): string {
  const parts: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const raw = fsSync.readFileSync(path.join(root(), name), "utf8");
      if (!raw.trim()) continue;
      parts.push(`### ${name}\n${raw.slice(0, 8_000)}${raw.length > 8_000 ? "\n…[truncated]" : ""}`);
    } catch {
      // Missing or unreadable file: nothing to inject.
    }
  }
  return parts.length ? `\n\n# Project instructions\n${parts.join("\n\n")}` : "";
}

/**
 * The skills index (see skills.ts). Read once per server construction — each
 * protocol era builds its own — so a skill added later is picked up by
 * `list_skills` rather than by a reconnect. A discovery failure must never keep
 * a session from starting.
 */
function skillsSuffix(): string {
  try {
    return skillsIndexSuffix(discoverWorkspaceSkills().skills);
  } catch {
    return "";
  }
}

/** Shared discovery guidance for both protocol eras. */
export function serverInstructions(): string {
  return SERVER_INSTRUCTIONS_BASE + shellSuffix() + notifySuffix() + projectInstructionSuffix() + skillsSuffix();
}

/**
 * What the connect-time prefix costs, in UTF-8 bytes: the instructions a client
 * is handed at discovery, and the serialized catalog from `tools/list`.
 *
 * Bytes rather than estimated tokens because bytes are exact, need no model
 * table, and are enough for the only two questions asked of them — did this
 * grow, and did it change between two identical requests. Never throws: a
 * measurement that could fail would take `bridge_status` down with it, and a
 * status surface that reports 0 is still telling the truth about itself.
 */
export function measurePrefix(): { instructions_bytes: number; catalog_bytes: number } {
  let instructionsBytes = 0;
  let catalogBytes = 0;
  try {
    instructionsBytes = Buffer.byteLength(serverInstructions(), "utf8");
  } catch {
    instructionsBytes = 0;
  }
  try {
    catalogBytes = Buffer.byteLength(JSON.stringify(listToolDefinitions()), "utf8");
  } catch {
    catalogBytes = 0;
  }
  return { instructions_bytes: instructionsBytes, catalog_bytes: catalogBytes };
}
