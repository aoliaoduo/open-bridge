/**
 * A compact, stable companion to a tool error's human-readable text.
 *
 * Handler errors remain prose because they must explain the next action to a
 * person. The MCP boundary classifies the common input-contract prefixes into
 * data that a client can branch on without re-parsing a changing sentence.
 */
export type ToolErrorKind = "missing" | "invalid" | "conflict";

export interface ToolErrorDetails {
  /** One of the stable P7 input-contract classes. */
  kind: ToolErrorKind;
  /** Canonical tool name, even when the caller used a legacy alias. */
  tool: string;
  /** Fields relevant to the input contract; empty when the message is domain-specific. */
  fields: string[];
  /** The unchanged human-readable explanation shown in the text content block. */
  message: string;
}

function kindOf(message: string): ToolErrorKind | undefined {
  if (/^Missing (?:one of )?"[^"\n]+"/.test(message)) return "missing";
  if (/^Invalid "[^"\n]+" value "[^"\n]+" for /.test(message)) return "invalid";
  if (/^Conflict: provide exactly one /.test(message)) return "conflict";
  return undefined;
}

function quotedFields(prefix: string): string[] {
  return [...prefix.matchAll(/"([^"\n]+)"/g)].map(match => match[1] ?? "");
}

/**
 * Turn a P7-style error message into structured data without rewriting its text.
 * Other domain errors deliberately remain text-only, preserving their prior wire shape.
 */
export function describeToolError(tool: string, message: string): ToolErrorDetails | undefined {
  const kind = kindOf(message);
  if (!kind) return undefined;
  const prefix = message.split(".", 1)[0] ?? message;
  const candidates = quotedFields(prefix);
  // An invalid-value sentence has both a field and the rejected value in quotes;
  // only the first is an actionable field name.
  const fields = kind === "invalid" ? candidates.slice(0, 1) : candidates;
  return { kind, tool, fields, message };
}
