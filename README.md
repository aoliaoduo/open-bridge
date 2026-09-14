# Open Bridge

[![CI](https://github.com/aoliaoduo/open-bridge-app/actions/workflows/ci.yml/badge.svg)](https://github.com/aoliaoduo/open-bridge-app/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

English | [简体中文](README.zh-CN.md)

Turn the files, commands, processes and services on your machine into a standard MCP endpoint, and hand it to ChatGPT on the web, Claude, Cursor, or any other MCP client.

**One Node process, one port, serving both the MCP endpoint and a web console.** No editor required.

| Data flow (top to bottom) | |
| --- | --- |
| AI client | ChatGPT web / Claude / Cursor / any MCP client — over an ngrok tunnel you control, or LAN-only, or loopback-only |
| `open-bridge serve` | three surfaces, below |
| The workspace you started it in | files, commands, processes, service orchestration |

| Surface | Path | Notes |
| --- | --- | --- |
| MCP | `/mcp/<route token>` | Streamable HTTP MCP — 39 tools, both protocol generations on one endpoint |
| Console | `/console/` | Web console, loopback only |
| API | `/api/*` | Console backend, gated by loopback *and* a token header |

### One endpoint, two protocol generations

`/mcp/<route token>` serves both the **2026-07-28** per-request protocol and the **2025-era** session protocol, and **the request itself decides which** — nothing to configure, no mode to pick:

| | 2026-07-28 (modern) | 2025 era (legacy) |
| --- | --- | --- |
| Handshake | none | `initialize` returns a session id |
| Per-request envelope | `params._meta` plus `MCP-Protocol-Version` / `MCP-Method` / `MCP-Call-Name` headers | none |
| Capability discovery | `server/discover` returns `supportedVersions` | `initialize` returns `protocolVersion` |
| Tool errors | JSON-RPC error | `isError: true` inside a JSON-RPC result |
| Resumption | none — there is no session to resume | `eventStore` plus SSE keepalive |

Both paths share one tool list, one usage counter and one audit log; the table above is the whole of the difference. Existing clients (Cursor, Claude Desktop, your own scripts) need no changes — sessions, locks and logs behave exactly as before.

Tools also carry MCP behaviour hints (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`). **These inform the client and the model; they do not constrain the bridge**: no call is refused, no tool is hidden, and no confirmation step is added because of them.

---

## Getting started

```bash
npm install -g .        # run once from the repo; afterwards open-bridge works anywhere
cd your-project
open-bridge serve                 # add --no-tunnel to stay local; --open launches the browser
```

Before the global install, `node bin/open-bridge.js <command>` works from the repo directory. `npm link` is the edit-and-run equivalent — it points the global command at this checkout, and `npm unlink -g open-bridge` undoes it.

**On Windows** there is `start-open-bridge.cmd` in the repo root. Double-click it and type the **working directory** (quoted or not — `"D:\work\my-project"` and `D:\work\my-project` both work). That directory becomes the workspace boundary the AI can see — **not** the directory the launcher lives in. Pressing Enter reuses the last one. The first run installs dependencies and builds. Closing the window stops the service, including the tunnel, background services and persistent shells; `Ctrl+C` is the clean stop. To pin a directory, add it as an argument to a shortcut: `"…\start-open-bridge.cmd" "D:\work"`.

`open-bridge stop` has a **self-stop guard**: if the command was issued by the instance it would stop — through its own MCP tools, say — it is refused by default, because stopping it severs the connection you are using to ask. To really stop it, run `open-bridge stop --force` from a terminal, or use the console.

The terminal prints three addresses and opens the console:

```
Web console:    http://127.0.0.1:18080/console/
Local MCP URL:  http://127.0.0.1:18080/mcp/<route token>
Public MCP URL: https://<your-domain>/mcp/<route token>      ← only with ngrok configured

Connecting a client: open-bridge prompt  →  copy the text, paste it to your client
```

Put the **MCP URL** into your client — or paste the output of `open-bridge prompt` where the client accepts it — and you are connected. Ctrl+C stops.

### Project conventions and skills

On connect, the server folds two things into the instructions it gives the AI: **project conventions** (`AGENTS.md` / `CLAUDE.md` at the workspace root, 8000 characters each at most) and a **skills index** — `skills/<name>/SKILL.md` in the workspace, plus `.agents/skills/`, `.claude/skills/`, the data directory (`~/.open-bridge/skills/`) and `~/.agents/skills/`.

The index carries names, descriptions and paths only; skill bodies stay out of the context window. When a task matches, the AI reads that SKILL.md with `read_files` and follows it. Skills added mid-session need no reconnect — `list_skills` rescans on every call. A workspace skill shadows a user-level skill of the same name, and the number shadowed is reported. The whole mechanism is **read-only**: the bridge never creates, syncs or rewrites a skill file.

### Many calls in one round trip: `run_script` (code mode)

`batch` bundles calls you **already know you need**. `run_script` goes further: the AI writes a small JavaScript program, composes calls with `await tools.<name>(args)` — loops, conditionals, `Promise.all`, filtering — and returns only what it actually wants.

The point is that **large tool output never has to enter the model's context**. "Find this string across 40 files" can be *one* script that reads and filters internally and brings back the handful of matching lines.

- Every `tools.x()` is a **real bridge call**: resource locks, audit log, redaction, session state and error semantics all apply. Nothing is bypassed.
- Scripts may call only the tools **this instance publishes** (profile filtering still applies). `run_script` and `batch` cannot be called from inside a script.
- **The sandbox contains nothing**: no filesystem, network, processes, `require`, timers or `eval` (a `vm` context with code generation from strings disabled). Tool names resolve in the parent process, so a typo gets the same "did you mean…" as a direct call.
- Each run is a **fresh scope**: data leaves only through `return`. `console` output comes back alongside the result but does not replace `return`.
- Failures return fixed fields — `phase`, `error_type`, `line`, `code_preview`, `hint` — so the AI **fixes the code and retries instead of apologising**.
- Arguments: `source` (required), `timeout_ms` (default 30s, max 300s), `max_calls` (default 60, max 200). Results over 64 KB are truncated with `truncated` set.

---

## The workspace is the directory you started in

No configuration file, no dropdown: **the workspace of `open-bridge serve` is the directory it was launched from**.

```bash
cd C:\work\project-a
open-bridge serve --port 18080        # this instance serves project-a

cd C:\work\project-b
open-bridge serve                     # a second instance, serving project-b, independent
```

- Both can run **at once**, each with its own port, route token and runtime record. Relative paths (`read_file("src/index.ts")`) always resolve against that instance's own directory.
- `open-bridge instances` lists every instance with pid, port and workspace, and marks which one matches the current directory.
- `stop` / `status` / `url` / `prompt` / `health` **default to the instance for the current directory**. With no instance here but exactly one running machine-wide, that one is used and the output says so. With several running and none here, you are asked to pick with `instances` — it never guesses.
- `--root DIR` overrides the default; `--home DIR` changes the data directory.

> **Ports**: without `--port` the default is `0`, a random free port each start, so the address changes. Pass `--port 18080` to pin it. An explicitly requested port that is busy is an error with a suggested alternative; a port **from the config file** that is busy falls back to a free one with a notice. Starting twice in the same directory is refused, naming the pid that holds it.

---

## Commands

| Command | Purpose |
| --- | --- |
| `open-bridge serve [--port N] [--root DIR] [--home DIR] [--no-tunnel] [--open]` | Run the bridge in the foreground; workspace = current directory |
| `open-bridge instances` | List every instance sharing this data directory (alias `list`) |
| `open-bridge status` | State, workspace, MCP URL, exposure |
| `open-bridge health` | Full check: listener, workspace, tunnel role, exposure level, tool count, build freshness — and one real request over the public URL |
| `open-bridge url` | Print the current MCP URL |
| `open-bridge prompt` | Print the connection prompt to paste into an AI client |
| `open-bridge logs [--tail N] [--follow] [--clear]` | Read, follow or clear the log |
| `open-bridge stop` | Stop the instance for the current directory |
| `open-bridge config list / get KEY / set KEY VALUE / path` | Read and write configuration |
| `open-bridge token create / list / revoke / delete / rotate` | Manage bearer tokens |
| `open-bridge doctor` | Diagnose the environment, including every running instance |
| `open-bridge version / help` | Version and help |

---

## Web console

Open `http://127.0.0.1:18080/console/` (the port follows `--port`). Every page has its own path, so it can be bookmarked, reloaded, or opened in a second window, and Ctrl+click opens a new tab. The bar under the header shows the current path and offers copy-MCP-URL, run-health-check and reload.

| Page | Path | What it does |
| --- | --- | --- |
| Status | `/console/status` | Workspace, MCP URL copy, health check, live sessions and file locks. Warns when publicly reachable without auth and links to Security. Flags a rebuilt `dist/` that has not been restarted |
| Sessions | `/console/sessions` | Who is connected: client name from the MCP handshake, idle time, in-flight requests, todo count — each can be **disconnected** |
| Tools | `/console/tools` | The `tools/list` this instance actually publishes, after profile filtering; core tools highlighted, searchable |
| Health | `/console/health` | Instance, workspace, tools, build, tunnel and exposure checked one by one, including a real `/healthz` request through the tunnel. Read-only diagnosis; exposure problems are fixed on the Security page |
| Services | `/console/services` | Save, start, stop and restart local service definitions |
| Logs | `/console/logs` | Live log stream over SSE; the full audit trail is `audit.log` in the data directory |
| Stats | `/console/stats` | Call counts, distribution by tool, recent activity |
| Security | `/console/security` | Exposure overview, bearer gate (issue and enable in one click), personal tokens — create, rotate, revoke, delete, purge — and OAuth 2.1. The old `/console/tokens` path redirects here |
| Settings | `/console/settings/…` | Seven subpages: `tunnel` / `network` / `files` / `shell` / `notify` / `locks` / `logs`. Deep-linkable, and sharing one validation layer with the MCP `get_config` / `set_config_value` tools |

The frontend router owns these paths (`ui/src/routes.ts`); the server returns the same page for any `/console/*` and injects the token, so adding a page needs no server change.

### Security boundaries

- `/api` and `/console` **answer loopback hosts only** (`127.0.0.1`, `localhost`). Reaching them through the public ngrok domain gets a 403; only `/mcp` is public.
- **CORS headers go to `/mcp`, `/oauth` and `/.well-known` only** — never to `/api`, `/console` or `/healthz`. The console is same-origin and never needed CORS, while three read-only `/api` endpoints return this instance's MCP address, **route token included** (`settings` in `state.mcpUrl`, `prompt` in its text, and `status`). One `Access-Control-Allow-Origin: *` would let any page open in your browser read it locally — the loopback check cannot stop a page inside the same browser, and private-network rules are vendor policy rather than specification.
- Every write requires an `X-Open-Bridge-Console` header matching the route token. The server injects it into the page; a cross-site page can neither read nor send it.
- **The bearer gate is off by default**, because URL-only clients such as the ChatGPT connector cannot send custom headers and would all break. Turn it on from the Security page: issue a token and flip the switch, or use **"issue a token and enable the gate"** to do both at once (an existing token is reused; the plaintext is shown once). With the gate on and no valid token, it **fails closed**. The local console can always turn it back off, so you cannot lock yourself out.
- **Publicly reachable means whoever has the URL can read and write your files and run commands.** The app will not quietly restrict your permissions, but it says this everywhere: `status`, the console, `health`, and the startup banner. To tighten it, enable the bearer gate — or run `--no-tunnel` and stay local.

> The full threat model, the three exposure levels, and **what is deliberately left unlocked** (`unrestrictedFileAccess` defaults on, exit codes are not verdicts, behaviour hints are information rather than limits) are in [`SECURITY.md`](SECURITY.md), which is also where vulnerability reports go.

### OAuth 2.1 (optional, off by default)

Some MCP clients only accept a standard authorization flow and will not take a token in a URL. With OAuth enabled, such a client registers itself and obtains **its own** credentials over OAuth 2.1 with PKCE:

```bash
open-bridge config set oauth.enabled true
```

The settings page does the same thing. Once on, a client discovers the server at `/.well-known/oauth-protected-resource`, registers at `/oauth/register`, and is sent to `/oauth/authorize` — **that page asks for your route token** (the string in the console URL; `OPEN_BRIDGE_OAUTH_OWNER` can replace it with a different passphrase) — and then receives access and refresh tokens.

- **Off by default.** Once on, `/mcp` requires **OAuth credentials**: a token in the URL no longer suffices. Capable clients receive 401 plus `WWW-Authenticate`, which is not a fault but the signal to begin authorizing, and end up with **individually revocable** credentials of their own. The route token in the path is a routing key, not a credential — "just paste the URL" was never a lock, and OAuth is the first thing here that is one.
- **Clients holding tokens keep working.** `Authorization: Bearer <token>` and `?token=<token>` still pass, whether or not the personal-token gate is on. (That is a fixed bug: OAuth used to reject before token validation when the gate was off.) For a client that only takes a URL and cannot send headers, give it a `?token=<token>` address, or leave OAuth off.
- **Visible and reversible from the console.** The OAuth 2.1 card is the switch, and it lists registered clients and how many credentials are live. `/api` and `/console` stay loopback-only, so the switch is always reachable.
- **S256 only.** `plain` is refused: these are public clients with no secret, and PKCE is the only proof of possession.
- **`resource` is required and must be this host**, otherwise a token issued here could be replayed against another service (RFC 8707).
- **Refresh tokens rotate once.** A used refresh token is dead immediately, so a replay buys nothing.
- The authorize, register and token endpoints are the only paths this exposes publicly. `/api` and `/console` remain loopback-only, and what the console reads (`/api/oauth`) contains **no secrets or digests**.

---

## Public tunnel (ngrok)

Local or LAN only? Add `--no-tunnel` and skip ngrok entirely.

To let an external client such as ChatGPT on the web reach you:

ngrok needs your account authtoken once before it will open a tunnel. Paste it into **Settings → Tunnel** in the console and save — or run `ngrok config add-authtoken <token>` if you prefer the terminal; either works, and the console entry exists so that a first run does not require one.

```bash
open-bridge config set ngrokDomain <your-reserved-domain>.ngrok-free.dev
open-bridge serve                 # note: without --no-tunnel; --open is optional
```

- A free ngrok account gets one subdomain, and **one domain can only be held by one instance at a time**. You do not have to stop the instance already holding it: the local instance registry (`bridge-peers.json`) is shared, so the tunnel holder looks up the token digest and forwards to the right instance. A new instance appends its row to the **existing** registry — it never fabricates one in someone else's directory — public requests arrive through that tunnel, `tunnel_role` reads `follower`, and the console notes that this address depends on another instance. When the holder exits, the next probe promotes this instance to `owner`.
- Claiming a domain is deliberately cautious: **only an explicit "nobody holds this" from ngrok counts as free**. Timeouts and 5xx mean "unknown" and it keeps watching. On `ERR_NGROK_334` (already taken) the instance serves locally, keeps watching that tunnel, and switches to `follower` the moment it sees traffic forwarded to it — it neither wedges itself nor starts a second ngrok to fight the first.
- A missing or misspelled domain produces a clear error such as `ERR_NGROK_313`; the local service is unaffected.

---

## Phone notifications (Bark)

You do not have to watch the tab while a web AI works. Paste the link the Bark app shows (`https://api.day.app/<device key>/…` — the whole thing; the key is extracted) into **Settings → Phone notifications** in the console, and the AI can push to your iPhone.

Two independent switches, both optional, not a choice between them:

| Switch | Behaviour |
| --- | --- |
| Notify on task done | One push per item ticked off the todo list — the server pushes when `set_todos` is written, not when the AI remembers |
| Notify on finish | One push when the exchange wraps up |

`attention` (come back to the computer) and `waiting` (the AI asked something and is blocked) **ignore both switches and always arrive**: an unanswered question strands the conversation indefinitely, which is not something a setting should swallow.

- **Per-call Bark knobs**: `sound`; `level` (`timeSensitive` pierces Focus modes, `critical` overrides silent mode); `volume` 0–10 (valid only with `critical`); `call: 1` to ring until opened; `badge`; `url` to open on tap; `group` (defaults to `open-bridge`, so several projects do not interleave on one phone); `icon`; `isArchive` to keep it in Bark's history; and `copy` / `autoCopy` to put a command or an id on the clipboard. The silence watchdog always uses `timeSensitive`.
  - Whether `critical` truly overrides silent mode depends on you granting Bark critical-alert permission in iOS. `volume` without `critical` is **refused by name** rather than dropped — someone who set it believed the push would be loud.
- **Silence watchdog**: after the configured number of quiet minutes (default 60, 0 disables), the server pushes by itself. When a web AI's tab dies or it is rate-limited into silence, this is the only channel left. **No todo list required** — the times the AI forgets to write one are exactly when you most need telling. (Measured in this repo's own audit log: 1274 tool calls in a day, 4 of them `set_todos`, zero notifications.)
- **Flood control**: real sends share a window of 6 per 60 seconds, plus 60-second deduplication of identical content. A suppressed call returns a structured `delivered:false`, not an error. The console's "send test" is a human action and is exempt.
- **The key only goes one way**: it can push to your phone and nothing else. The console and `get_config` show a mask; the audit and runtime logs never contain it. `notify.serverUrl` can point at a self-hosted Bark (plain http is allowed on loopback only).
- When the channel is off — switch disabled or no key — a `notify` call returns an explicit reason and the work continues unaffected.

---

## Data directory

Defaults to `~/.open-bridge`; `OPEN_BRIDGE_HOME` or `--home` changes it.

```
config.json              Configuration (config-defaults.ts is the schema's single source of truth)
state.json               Persistent state: service definitions, todos, usage counters
secrets.json             Route token plus hashed token records; plaintext is never written
audit.log                Append-only audit log, rotating at 1 MiB
logs/bridge.log          Bridge and service logs, read by `open-bridge logs`; rotates at 10 MiB
                         to bridge.log.1 (`logMaxBytes` adjusts it, 0 disables rotation)
runtime-<suffix>.json    One runtime record per workspace: pid, port, root
bridge-peers.json        Local instance registry, used when instances share a tunnel
```

Instances sharing a data directory share **configuration, tokens and the registry**, while **runtime records and route tokens are per workspace** (the suffix is the first 24 bits of the workspace path hash).

> Upgrading: an older single `runtime.json` is still read, but only when the root it records is the one being looked for — so an instance for directory A is never mistaken for one for B.

---

## FAQ

**Port already in use?**
`open-bridge instances` shows whether one is already running. Use `--port 18081`, or `open-bridge stop` first.

**The public address does not respond?**
`open-bridge health` makes a real request over the public URL and reports status and timing. `tunnel_role: follower` means the address is borrowed from another instance; it will change when that instance exits, and this one takes over when it can.

**The MCP client reports a transport error (SSL EOF, connection reset, timeout)?**
Free ngrok tunnels hiccup occasionally. Wait five seconds and retry once — the connection prompt already says so, and no client configuration is needed.

**Worried about being wide open?**
`status`, `health` and the console all state the current exposure level (`local`, `public-open`, `public-authed`). To tighten it, issue a token on the Security page and enable the bearer gate; to avoid exposure entirely, use `--no-tunnel`.

---

## Development

```bash
npm install
npm run build        # tsc for core and CLI, vite for the React console
npm run verify       # typecheck + lint + build + every test (unit, integration, UI)
npm run dev -- serve --no-tunnel   # run straight from source with tsx
```

Tests come in three layers. `test/*.test.ts` are unit tests. `test/*-integration.test.mjs` **actually start `bin/open-bridge.js` and speak HTTP** — the shell, the auth gate, both MCP generations, multi-instance behaviour. UI tests live beside their components in `ui/src/**`, because vitest will silently skip them anywhere else.

The auth-gate and protocol-invariant suites are older than most of the code around them: every assertion in them was bought with a real incident, so read them as incident reports before changing one.

Architecture: `src/bridge|http|mcp|network|process|shell|workspace` is the host-independent core; `src/host/` is the host abstraction (a Host interface plus a file-backed implementation); `src/server/` is the API and console; `src/cli.ts` is the entry point. Wrapping it in a different host — Tauri, say — means implementing that one interface. Inside `src/bridge/` each file has a single job: `lifecycle.ts` decides when to start and stop and who owns the public domain, `http-listener.ts` owns the socket and dispatches both MCP generations, `tunnel.ts` owns the ngrok process and reconnection, `session-table.ts` / `peer-registry.ts` / `mcp-endpoint.ts` own the session table, peer registry and protocol endpoint, and `route-hooks.ts` is the host hook. Dependencies run one way, with no cycles.

Dependencies at runtime are `@modelcontextprotocol/server` with `@modelcontextprotocol/node` (2.x, the 2026-07-28 per-request protocol) and `@modelcontextprotocol/sdk` (1.x, the 2025-era session transport). **There is no web framework** — `/mcp`, `/api` and `/console` all sit directly on `node:http`.

---

## Two things deliberately not done

- **Switching workspace at runtime.** The answer is "a second directory is a second instance". Re-rooting a live instance would mean rewriting where open file handles, process working directories, the lock table and the audit log all point, and missing any one of them is a cross-directory bug that is miserable to track down. A second instance has none of that.
- **Mirroring process output to a real terminal.** A background process that pops a system window is disruptive, and closing that window kills the process. Output stays in the buffer and is read on demand with `read_process_output`.

## License

MIT © Open Bridge contributors
