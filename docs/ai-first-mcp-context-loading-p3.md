# MCP discovery and context loading

This reference describes Bridge-controlled protocol behavior, not a
third-party model's hidden prompt packing. The original P3 measurement is
available in Git history; fixed payload sizes and instruction lengths are
not current product guarantees.

## When payloads are sent

| Protocol route | Exchange | Payload |
| --- | --- | --- |
| 2025 generation, stateful | `initialize` | Server/project instructions and a new session id. |
| 2025 generation, stateful | `tools/list` | The canonical catalog for the configured tool profile. |
| 2025 generation, stateful | `tools/call` | The requested result, not the entire catalog or instruction snapshot. |
| 2026-07-28 generation, stateless | `server/discover` | Server/project instructions, with no session minted. |
| 2026-07-28 generation, stateless | `tools/list` | The same profile-filtered catalog without a stateful handshake. |
| 2026-07-28 generation, stateless | `tools/call` | The requested result, without repeating discovery instructions. |

Both generations share `serverInstructions()` and result construction in
`src/bridge/mcp/mcp-endpoint.ts`. The Bridge does not attach the complete catalog
to ordinary tool results. The client decides how often to discover/list,
what to cache, and what to include in a model turn.

## Existing controls

### Bounded project instructions

The instruction snapshot combines base execution guidance, the actual shell,
notification guidance, root `AGENTS.md` / `CLAUDE.md`, and discovered skills.
Each project instruction file is capped at 8,000 characters. Keep those
files concise and accurate rather than duplicating the tool reference.

### Operator-selected catalog profile

`toolProfile` is a per-Bridge setting, not automatic client/task negotiation.
`full` remains the default; `core` is an opt-in subset and omits capabilities
such as named-service orchestration. The actual membership is maintained in
`src/bridge/tools/tool-catalog.ts`; use `tools/list` to inspect the running instance.

Per-tool descriptions have a 200-character budget, enforced by
`test/tool-descriptions.test.ts`. Detailed behavior belongs in
[tools.md](tools.md), not in repeated connection-time prose.

## Measuring a proposed change

1. Confirm the live build with `bridge_status{section:"overview"}`.
2. Record the client, selected profile, protocol generation and representative
   task. For a 2025 client, perform a real initialize/initialized handshake;
   let the SDK build the modern request envelope for a modern client.
3. Compare discovery/initialization, `tools/list`, and a read-only call such as
   `bridge_status`. Count UTF-8 HTTP body bytes including JSON/SSE framing
   separately from instruction characters.
4. Verify both protocol paths with `test/mcp-protocol-integration.test.mjs`
   and `test/mcp-modern-protocol-integration.test.mjs` after building.
5. If the claim concerns model-context cost, also measure the actual client's
   request frequency, tool availability, task completion and recovery. Wire
   bytes alone are not a token count or evidence that tools should be removed.

No new profile, smaller default catalog or extra indirection is justified
without evidence that the intended client/task benefits and retains needed
capabilities. See the [product baseline](ai-first-mcp-baseline.md).
