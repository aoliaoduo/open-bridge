/**
 * Pure formatting helpers for the lsp tool's result envelope (ShunCode-style
 * result governance): bounded output budgets, provider-state disclosure and
 * workspace-symbol warm-up scoring. No vscode imports so it stays
 * unit-testable in plain node; the vscode-touching orchestration lives in
 * bridge/meta-tools.ts.
 */
import { boundedText } from "./line-diff.js";

/** Hard per-call result cap for lsp operations. */
export const LSP_HARD_MAX_RESULTS = 500;
/** Whole-envelope character budget; blocks past it are dropped with truncated:true. */
export const LSP_MAX_OUTPUT_CHARS = 64_000;
/** Per-hover content budget (head+tail). */
export const LSP_MAX_HOVER_CHARS = 16_000;

/** Numeric vscode.SymbolKind → readable name (embedded so no vscode import). */
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class", 6: "Method",
  7: "Property", 8: "Field", 9: "Constructor", 10: "Enum", 11: "Interface",
  12: "Function", 13: "Variable", 14: "Constant", 15: "String", 16: "Number",
  17: "Boolean", 18: "Array", 19: "Object", 20: "Key", 21: "Null",
  22: "EnumMember", 23: "Struct", 24: "Event", 25: "Operator", 26: "TypeParameter",
};

export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? String(kind);
}

export function positionText(line: number, character: number): string {
  return `${line + 1}:${character + 1}`;
}

/**
 * Split a symbol query into lowercase tokens (camelCase aware, >= 3 chars) so
 * file-name warm-up candidates can be scored against it.
 */
export function queryTokens(query: string): string[] {
  const expanded = query.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return [...new Set(
    expanded
      .split(/[^A-Za-z0-9]+/)
      .map(part => part.toLowerCase())
      .filter(part => part.length >= 3),
  )];
}

/** Candidate ranking for the workspace-symbols warm-up (basename hits dominate). */
export function warmupCandidateScore(relativePath: string, query: string, tokens: readonly string[]): number {
  const lowerPath = relativePath.toLowerCase();
  const lowerBase = lowerPath.split("/").pop() ?? lowerPath;
  const lowerQuery = query.toLowerCase();
  let score = 0;
  if (lowerBase.includes(lowerQuery)) score += 200;
  if (lowerPath.includes(lowerQuery)) score += 100;
  for (const token of tokens) {
    if (lowerBase.includes(token)) score += 30;
    else if (lowerPath.includes(token)) score += 10;
  }
  return score;
}

/** Head+tail truncation (40% head) that keeps both ends readable. */
export function boundedHoverText(text: string, maxChars = LSP_MAX_HOVER_CHARS): { text: string; truncated: boolean } {
  return boundedText(text, maxChars);
}

export interface EnvelopeResult {
  text: string;
  returned: number;
  truncated: boolean;
}

/**
 * Render result blocks under a fixed header with a whole-envelope character
 * budget. Blocks beyond maxResults or the budget are dropped and disclosed.
 */
export function emitEnvelope(
  headerLines: string[],
  blocks: string[],
  totalResults: number,
  maxResults: number,
  maxChars: number = LSP_MAX_OUTPUT_CHARS,
): EnvelopeResult {
  const selected = blocks.slice(0, Math.max(0, maxResults));
  let truncated = totalResults > selected.length;
  let used = headerLines.join("\n").length;
  const emitted: string[] = [];
  for (const block of selected) {
    if (used + block.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    emitted.push(block);
    used += block.length + 1;
  }
  const text = [
    ...headerLines,
    `returned_results: ${emitted.length}`,
    `total_results: ${totalResults}`,
    `truncated: ${truncated}`,
    "--- RESULTS ---",
    ...emitted,
  ].join("\n");
  return { text, returned: emitted.length, truncated };
}
