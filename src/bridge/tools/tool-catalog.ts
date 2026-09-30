/**
 * The advertised tool catalog — the single definition of "what this instance
 * offers".
 *
 * One filter applies: the operator's toolProfile ("core" narrows the set).
 *
 * Kept in its own module so the MCP `tools/list` handler and the Bridge status
 * surface (`tool_count`) can never drift apart on how many tools are on offer.
 *
 * Behaviour annotations are merged in here rather than stored in the definitions
 * literal, so both protocol eras (`/mcp` legacy and the 2026-07-28 stateless
 * path) and the console's tools page all report identical hints from one place.
 * A tool with no entry in the annotation table advertises none: the hints are
 * information, never a gate, and never silently invented.
 *
 * Output-schema `description` keywords are documentation-only JSON Schema
 * annotations. The complete prose remains in TOOL_DEFINITIONS/docs/tools.md,
 * while the wire catalog drops those repeated annotations to keep the prefix
 * bounded. Validation keywords, field names, required sets and enums are kept.
 */

import { host } from "../../host/host.js";
import { CORE_TOOLS, TOOL_DEFINITIONS } from "../../mcp/tool-definitions.js";
import { annotationsFor } from "./tool-annotations.js";

function stripOutputDescriptions<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => stripOutputDescriptions(item)) as T;
  if (value === null || typeof value !== "object") return value;
  const compact: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "description") continue;
    compact[key] = stripOutputDescriptions(item);
  }
  // `description` is annotation-only in JSON Schema, so removing it does not
  // change the validation shape represented by T. Keep the source literal's
  // type so both MCP SDK adapters retain their existing compile-time contract.
  return compact as T;
}

function compactForWire<T extends { name: string }>(tool: T): T {
  if (!("outputSchema" in tool)) return tool;
  return {
    ...tool,
    outputSchema: stripOutputDescriptions((tool as T & { outputSchema: unknown }).outputSchema),
  };
}

const WIRE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.map(compactForWire);

/**
 * One tool as advertised: the definition with output-only description metadata
 * compacted, plus its behaviour hints when the annotation table has them.
 *
 * The spread order matters — annotations are added, never allowed to overwrite a
 * definition field, so a future `annotations` key inside `TOOL_DEFINITIONS`
 * could not silently disagree with the table.
 */
function withAnnotations<T extends { name: string }>(tool: T): T & { annotations?: unknown } {
  const annotations = annotationsFor(tool.name);
  return annotations ? { ...tool, annotations } : tool;
}

/** Effective catalog for tools/list, after the toolProfile filter. */
export function listToolDefinitions(): Array<(typeof TOOL_DEFINITIONS)[number] & { annotations?: unknown }> {
  const profile = host().config.get<string>("toolProfile", "full");
  const catalog = profile === "core"
    ? WIRE_TOOL_DEFINITIONS.filter(tool => CORE_TOOLS.has(tool.name))
    : [...WIRE_TOOL_DEFINITIONS];
  return catalog.map(withAnnotations);
}
