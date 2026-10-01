import { state } from "./runtime-state.js";

/** Loopback MCP URL — valid exactly while the server is listening. */
export function localMcpUrl(): string {
  return state.server && state.port
    ? `http://127.0.0.1:${state.port}/mcp/${state.routeToken}`
    : "";
}

/** The MCP URL to hand a client: public tunnel when present, else loopback. */
export function clientMcpUrl(): string {
  return state.tunnelUrl || localMcpUrl();
}

export function redactedPublicUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/mcp/<redacted>`;
  } catch {
    return "<redacted>";
  }
}

export function redactSensitiveText(value: string): string {
  let result = value;
  for (const url of [state.tunnelUrl, localMcpUrl()]) {
    if (url) result = result.split(url).join(redactedPublicUrl(url));
  }
  if (state.routeToken) result = result.split(state.routeToken).join("<redacted>");
  result = result.replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, "$1<redacted>");
  result = result.replace(/([?&](?:token|key|api[_-]?key|secret|password)=)[^&\s]+/gi, "$1<redacted>");
  result = result.replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|KEY))=([^\s"']+)/g, "$1=<redacted>");
  return result;
}
