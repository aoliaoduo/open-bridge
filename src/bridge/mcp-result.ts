/** Convert an arbitrary tool value into MCP structuredContent's object shape. */
export function asStructuredContent(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (Array.isArray(value)) return { items: value };
  return { value };
}

/** Serialize one tool result as the single MCP text content block. */
export function text(value: unknown): { content: [{ type: "text"; text: string }] } {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? [], null, 2);
  return { content: [{ type: "text", text: serialized ?? "[]" }] };
}
