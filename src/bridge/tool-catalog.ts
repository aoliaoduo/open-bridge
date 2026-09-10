/**
 * The advertised tool catalog — the single definition of "what this instance
 * offers".
 *
 * Two filters apply, in order: the operator's toolProfile ("core" narrows the
 * set), then the host's capabilities (editor-only tools exist solely where the
 * host ships a language server).
 *
 * Kept in its own module so the MCP `tools/list` handler and the Bridge status
 * surface (`tool_count`) can never drift apart on how many tools are on offer.
 */

import { host } from "../host/host.js";
import { CORE_TOOLS, TOOL_DEFINITIONS } from "../mcp/tool-definitions.js";

/** Editor-integration tools that only exist when the host ships a language server. */
export const EDITOR_ONLY_TOOLS = new Set(["get_diagnostics", "lsp"]);

/** Effective catalog for tools/list: toolProfile filter, then host-capability filter. */
export function listToolDefinitions(): Array<(typeof TOOL_DEFINITIONS)[number]> {
  const profile = host().config.get<string>("toolProfile", "full");
  const catalog = profile === "core"
    ? TOOL_DEFINITIONS.filter(tool => CORE_TOOLS.has(tool.name))
    : [...TOOL_DEFINITIONS];
  return host().capabilities.lsp ? catalog : catalog.filter(tool => !EDITOR_ONLY_TOOLS.has(tool.name));
}
