# AI-first MCP context-loading evidence (P3)

**Status:** measured baseline, 2026-09-20
**Audience:** Open Bridge maintainers and AI agents. This records MCP transport facts; it does not claim to measure a third-party model's hidden prompt packing.

## Question

P0 measured a 39-tool catalog of roughly 65 KB and connection instructions of roughly 9.5K characters. P3 answers what the Bridge itself can prove about when those payloads are sent, across both supported MCP protocol eras.

The project advertises a standard endpoint usable by ChatGPT, Claude, Cursor, and other MCP-capable clients. Those clients decide whether and how they place discovered tools in model context; the Bridge can observe protocol requests, not a provider's internal prompt cache.

## Live wire observations

The following requests were made to the running Bridge after P2's restart. “Wire bytes” is UTF-8 HTTP response body size, including JSON/SSE framing where present; it is **not** a token estimate.

| Protocol route | Exchange | Wire bytes | Instructions | What the Bridge can conclude |
| --- | --- | ---: | ---: | --- |
| Legacy, stateful | `initialize` | 15,290 | 9,468 characters | A session is minted and receives the server/project instructions at handshake. |
| Legacy, stateful | `tools/list` | 66,140 | not repeated | The client explicitly requests the 39-tool catalog. |
| Legacy, stateful | `tools/call(get_bridge_status)` | 1,911 | not repeated | Ordinary tool calls carry their result, not connect-time instructions. |
| Modern 2026-07-28, stateless | `server/discover` | 15,331 | 9,468 characters | No session is minted; discovery receives the same instruction snapshot. |
| Modern 2026-07-28, stateless | `tools/list` | 66,238 | not repeated | The same 39-tool catalog is available without a handshake. |
| Modern 2026-07-28, stateless | `tools/call(get_bridge_status)` | 2,022 | not repeated | Direct calls do not repeat instructions. |

Therefore, the Bridge does **not** attach the catalog or its instructions to every tool result. It sends instructions on the era's discovery/initialization exchange and sends the catalog only when a client asks for `tools/list`.

What remains outside the server's evidence: whether a particular ChatGPT, Claude, Cursor, or other client calls `tools/list` once or repeatedly; whether it caches schemas; and how many model tokens it assigns to either payload.

## What controls are already available

### Bounded project instructions

Both protocol eras use one `serverInstructions()` source. It combines base execution guidance, a shell/notification snapshot, root `AGENTS.md` / `CLAUDE.md`, and a skill index. Each project instruction file is capped at the first 8,000 characters before it is sent. This prevents an unbounded repository instruction file from making the connection payload unbounded, while keeping project conventions available at discovery.

### Operator-selected catalog profile

The existing `toolProfile` is a global per-Bridge setting, not a client- or task-specific negotiation:

- `full` is the default and advertises 39 tools.
- `core` advertises 20 tools. The raw checked-in definition payload is 33,410 bytes versus 62,834 bytes for `full` before protocol framing/annotations.

This is a real context-size lever, but it also removes capabilities such as named services and several operational tools. P3 does **not** change the default profile or introduce new profiles: a byte reduction alone does not establish that a narrower catalog completes the user's task more reliably.

## Decisions

1. Keep `full` as the default. The current evidence shows bounded transmission, not a repeated-per-call catalog defect.
2. Do not split, remove, or rewrite tool descriptions merely to reduce the measured payload.
3. Treat any catalog/profile change as an AI task-completion decision: it must name the client/task class that benefits and demonstrate that omitted tools are not needed.
4. Keep the existing 200-character per-tool description budget and the 8,000-character-per-project-instruction cap as the current guardrails.

## Next evidence needed before optimization

A future client-specific benchmark should record, for a named client and representative task, the number of discovery/list requests, tool availability in the model turn, completion quality, and recovery behavior. Only that experiment can justify changing the default profile, introducing task-specific catalogs, or further shrinking connection instructions.

## Verification performed

- Inspected the shared legacy/modern instruction assembly, catalog filter, config defaults, client-facing setup documentation, and protocol integration coverage.
- Performed live legacy `initialize` / `tools/list` / `tools/call` and modern `server/discover` / `tools/list` / `tools/call` exchanges.
- Confirmed a running fresh Bridge, 39 advertised full-profile tools, identical 9,468-character instruction snapshots, no instructions repeated by ordinary tool calls, and no modern session id.
