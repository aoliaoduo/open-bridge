# AI-first MCP product baseline

This is the product contract for Open Bridge, not a queue of unfinished
migration tasks. Historical P0/P1/P2/P3/P5/P8 measurements and completion
records remain in Git history; obtain current counts, schemas and runtime
state from the checked-in definitions and the live Bridge.

## Product boundary

Open Bridge's MCP surface is executed by an AI agent. People install,
configure, read, and supervise the project; they are not the direct caller of
individual MCP tools. Optimize, in order, for:

1. selecting the right tool without guessing;
2. supplying valid arguments from the advertised schema;
3. consuming a deterministic typed result or a recoverable failure;
4. completing related work in few calls and bounded context; and
5. truthful process, service, and file state.

Human-facing documentation helps orientation and deployment, but must not
drive the MCP contract at the expense of correctness, speed or capability.

## Acceptance criteria

A change should state which criterion it improves and demonstrate affected
runtime behavior at the MCP boundary:

- **Selection:** an agent can identify the canonical tool and branch.
- **Construction:** required arguments, mutually exclusive inputs, defaults
  and limits are explicit in the advertised schema.
- **Interpretation:** success, partial success and tool failure have
  distinguishable structured shapes. A non-zero command exit is not a tool
  failure; one unreadable file need not discard readable sibling results.
- **Recovery:** a failed command or service launch never reports false
  success. Pagination, truncation and incomplete search coverage tell an
  agent what it can safely do next.
- **Efficiency:** independent work can use `batch`; filtering and composition
  can use `run_script`. Neither should hide facts the caller needs.
- **Context:** new metadata earns its discovery-time cost. See the
  [context-loading reference](ai-first-mcp-context-loading-p3.md).

## Existing coverage and sources of truth

| Concern | Implementation / verification |
| --- | --- |
| Canonical catalog and profiles | `src/bridge/tool-catalog.ts`, `src/bridge/tool-families.ts` |
| Published input/output contracts | `src/mcp/tool-definitions.ts`, `test/tool-output-shapes.test.ts`, protocol integration suites |
| Shared protocol result construction | `src/bridge/mcp-endpoint.ts` |
| Orientation, grouped inspection, row failure and script projection | `test/mcp-protocol-integration.test.mjs` |
| Both protocol generations | `test/mcp-protocol-integration.test.mjs`, `test/mcp-modern-protocol-integration.test.mjs` |
| Read continuation and incomplete search | `test/read-files-continuation.test.ts`, `test/search-partial.test.ts` |
| Honest process/service recovery | `test/process-timeout-integration.test.mjs`, `test/process-restart-honest.test.ts`, `test/service-start-honest.test.ts` |
| Description budget and detailed tool reference | `test/tool-descriptions.test.ts`, [tools.md](tools.md) |

These are existing protections, not proposals to implement again. Audit the
current code and tests before claiming a gap; if a reproducible gap remains,
add coverage that fails before the fix.

## Non-goals

- Do not remove working tools or change permissions just because discovery
  contains many bytes.
- Do not mechanically annotate every self-explanatory schema field.
- Keep compatibility aliases as an internal migration aid rather than
  duplicate discovery entries; being old is not evidence of being unused.
- Do not reintroduce a behavior-coach or prompt-only restriction layer.
- Do not infer a third-party client's model-context cost from wire bytes.

For execution, release checks, review, commits and restart verification,
follow the [collaboration workflow](agent-collaboration-workflow.md). Architecture
and module ownership are maintained in [ARCHITECTURE.md](../ARCHITECTURE.md).
