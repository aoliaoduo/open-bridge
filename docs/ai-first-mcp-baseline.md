# AI-first MCP baseline (P0)

**Status:** accepted baseline, 2026-09-20
**Audience:** maintainers and AI agents working on Open Bridge. This is a product-contract record, not an end-user tool tutorial.

## Product boundary

Open Bridge's MCP surface is executed by an AI agent. People install, configure, read, and supervise the project; they are not the direct caller of individual MCP tools. Work should therefore optimize, in order, for:

1. an agent selecting the right tool without guessing;
2. an agent supplying valid arguments from the advertised schema;
3. an agent consuming a deterministic typed result or a recoverable failure;
4. completing related work in few calls and with bounded context; and
5. truthful process, service, and file state.

Human-facing documentation remains useful for project orientation and deployment, but it must not drive the MCP contract at the expense of agent correctness, speed, or expressive power.

## P0 evidence

The measurements below were taken from the live Bridge after restart, plus the checked-in tool definitions.

| Check | Result | Agent-facing conclusion |
| --- | --- | --- |
| Canonical tool catalog | 39 tools | The catalog exposes canonical names only; compatibility aliases do not bloat agent choice. |
| Schemas | 39/39 have input schema and output schema | Every advertised tool has machine-readable request and result structure. |
| Tool discovery payload | 65,633 serialized bytes; 5,962 description characters | Complete and self-contained, but large enough to treat context cost as a measured constraint rather than add prose casually. |
| Initialization instructions | 9,468 characters | Useful workspace guidance is available at connection time; additions need a clear agent-execution payoff. |
| Input-field guidance | 149/166 schema fields carry descriptions | The 17 omissions are repeated discriminators or self-naming fields (`action`, `op`, `tool`, `arguments`, `id`, `title`, `status`, `old_text`, `new_text`), not a confirmed callability defect. |
| Error/result routing | Shared tool-call result builder across modern and legacy protocols | Protocol-era routing does not create a separate agent-facing error contract. |
| Batch live flow | 3 independent introspection calls completed in parallel; 3/3 succeeded | An agent can group independent reads and receive per-item success state. |
| Script live flow | A script composed 2 tool calls and returned only three selected fields, without truncation | An agent can reduce roundtrips and keep irrelevant bulk outside its context. |

## What P0 did **not** change

No runtime behavior, permission model, tool catalog, or user interface was changed. In particular:

- a large catalog payload is an observation, not proof that tools should be removed;
- missing descriptions on every output field are not automatically a defect when field names, types, and required sets already make the contract unambiguous;
- compatibility aliases remain an internal migration aid, not an agent discovery surface; and
- no "behavior coach" or prompt-only restriction layer is reintroduced.

## Baseline acceptance criteria for later work

A proposed MCP change should state which of these it improves and demonstrate it with a real protocol test when it changes runtime code:

- **selection:** the agent can identify the right canonical tool and branch;
- **construction:** required arguments, mutually exclusive inputs, defaults, and limits are explicit;
- **interpretation:** success, partial success, and failure have distinguishable structured shapes;
- **recovery:** a failed command or service start never reports a false success, and an agent can see the next useful fact;
- **efficiency:** independent work can use `batch`; multi-step filtering can use `run_script`; neither is used merely to hide essential results;
- **context:** new metadata earns its connection-time or tool-list cost.

## Ranked follow-up candidates

1. **Recommended: durable AI task-flow contract tests.** Capture a compact set of representative agent flows—orientation, grouped inspection, scoped script result, and an honest recoverable failure—at the MCP boundary. This protects behavior that single-tool unit tests cannot see, without inventing a second abstraction layer.
2. **Targeted branch-schema clarity.** Audit only the action/operation branches that have produced real agent mistakes or ambiguous output variants; add precise descriptions or constraints there rather than annotate every field mechanically.
3. **Measured context shaping — P3 complete.** See [the transport evidence](ai-first-mcp-context-loading-p3.md): instructions are discovery/initialization payloads and the catalog is sent only on tools/list, while actual model-context packing remains client-specific. Do not optimize from byte count alone.
4. **Execution-lifecycle evidence.** Continue prioritizing truthful asynchronous process and service outcomes when a reproducible gap is found; P10's failed-start contract is the current baseline for this category.

## Verification performed for P0

- Inspected the checked-in catalog, schemas, shared MCP result construction, and existing protocol/batch/script tests.
- Executed live MCP `workspace_brief`, a parallel `batch` of three read-only calls, and a `run_script` that composed two calls and returned a compact projection.
- Re-ran both modern-protocol and legacy/general MCP integration suites; all passed.
