# Open Bridge

<div align="center">

**Give ChatGPT, Claude, or any remote MCP-capable client controlled access to a real workspace on your machine.**

Files, commands, long-running processes, services, and automation — exposed through one standard MCP endpoint.

[![CI](https://github.com/aoliaoduo/open-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/aoliaoduo/open-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

**English** · [简体中文](README.zh-CN.md)

[Quick start](#quick-start) · [Highlights](#highlights) · [Windows](#windows) · [Security](#security) · [Documentation](#documentation)

</div>

---

## What is Open Bridge?

Open Bridge is a standalone MCP bridge that lets remote AI clients work against a real directory on your machine.

Run it inside a directory and that directory becomes available through MCP. The common path is a public HTTPS tunnel via ngrok or Tailscale Funnel; `--no-tunnel` is there for local-only development or private use.

```text
ChatGPT / Claude / remote MCP client
                    │
              HTTPS + MCP
                    ▼
          ngrok / Tailscale Funnel
                    │
          forwards to loopback
                    ▼
             Open Bridge
          one Node process
                    │
        ┌───────────┼────────────┐
        ▼           ▼            ▼
      Files      Commands     Processes
        │           │            │
        └───────────┼────────────┘
                    ▼
               Your workspace

        Web console stays local:
      sessions · logs · health · settings
```

One process. One port. No web framework. No editor lock-in.

## Quick start

From a checkout of this repository:

```bash
npm ci
npm run build
npm install -g .

cd your-project
open-bridge serve
```

Open Bridge prints an MCP URL. Add that URL to your MCP client and the client is connected to the directory you started it from.

Typical endpoints:

```text
Public MCP URL: https://<your-domain>/mcp/<route-token>   ← normal client connection
Web console:    http://127.0.0.1:18080/console/           ← local administration
Local MCP URL:  http://127.0.0.1:18080/mcp/<route-token>  ← local/debug use
```

> **Treat the MCP URL as a credential.** The normal remote setup publishes the MCP endpoint through ngrok or Tailscale Funnel, so protect the full URL. When your client supports credentials, enable the bearer gate or OAuth from the console's **Security** page.

For the usual remote workflow, open the Web console after startup and use **Settings → Tunnel → Auto-configure** to publish the workspace. First time using ngrok or Tailscale? Follow the **[public tunnel quick start](docs/tunnels.md)**. For a stable local listener port:

```bash
open-bridge serve --port 18080
```

For local-only development or a machine that should not be reachable remotely:

```bash
open-bridge serve --no-tunnel
```

## Highlights

| Capability | What it gives you |
| --- | --- |
| **Complete MCP toolset** | Read, write, patch, search, run commands, supervise processes, manage services, inspect activity, and compose work with `run_script`. |
| **Modern + legacy MCP** | Two MCP protocol generations share one endpoint and are selected per request. Older clients keep working without a second server. |
| **Real process supervision** | Long-running commands have IDs, output buffers, lifecycle controls, restart policy, and cleanup semantics. |
| **Named services** | Define and operate reusable workspace services with health checks, logs, ports, and restart behavior. |
| **Web console** | Sessions, tools, logs, locks, health, exposure, tunnel state, OAuth, tokens, notifications, and settings. |
| **OAuth 2.1 + PKCE** | Optional standards-based authorization for clients that support a full OAuth flow. |
| **Bearer gate** | Optional individually issued tokens for clients that can send credentials directly. |
| **Public HTTPS tunnels** | The primary remote transport: ngrok and Tailscale Funnel with detection, health checks, ownership, and reconnect behavior. |
| **Code Mode** | `run_script` composes Bridge tools inside an isolated Worker/VM sandbox to reduce roundtrips and return only the data you need. |
| **Operator notifications** | Bark push notifications or local sounds when the AI is waiting for input or a conversation finishes. |
| **Auditable behavior** | Activity history, usage statistics, logs, exposure state, diagnostics, and resource-lock visibility. |

## How workspaces behave

Three rules explain most day-to-day behavior.

### The current directory is the workspace

Start Open Bridge inside a directory:

```bash
cd my-project
open-bridge serve
```

That directory becomes the project root. Starting another instance in another directory gives you another independent workspace.

### Ports are dynamic unless pinned

Without `--port`, Open Bridge chooses an available port. Use a fixed port when you need a stable URL:

```bash
open-bridge serve --port 18080
```

### The terminal owns the instance

The process runs in the terminal that launched it. Closing that terminal stops the instance and releases its resources.

For the full command and configuration reference, see **[docs/configuration.md](docs/configuration.md)**.

## Windows

The recommended Windows workflow is the Explorer context menu:

```bash
open-bridge explorer install
```

Then right-click a folder, or the background inside it, and choose **Start Open Bridge Here**. On Chinese Windows the label is **在此启动 Open Bridge**.

The launcher:

- passes the workspace to Node without interpolating the path through PowerShell or `cmd.exe`;
- reuses an existing workspace instance instead of starting a duplicate;
- opens a **visible TUI in Windows Terminal** when starting a new instance;
- opens the existing Web console on a later click when that workspace is already running;
- falls back to opening the Web console rather than leaving an invisible background Bridge when Windows Terminal is unavailable;
- registers per-user under `HKCU\Software\Classes`, so administrator rights are not required.

Remove the menu with:

```bash
open-bridge explorer uninstall
```

<details>
<summary><strong>Windows launcher and compatibility details</strong></summary>

Windows 11 may place the classic shell verb under **Show more options**.

The historical PowerShell install/uninstall scripts remain as compatibility wrappers and delegate to the same Node/TypeScript CLI.

`scripts/start-open-bridge.cmd` and `scripts/start-open-bridge-project.cmd` are intentionally thin double-click bootstraps. Workspace selection, persistence, build/start policy, and the repository's fixed **8123** development port live in Node/TypeScript.

The generic `.cmd` launcher intentionally accepts no workspace or flag arguments because `cmd.exe` expands literal `%NAME%` sequences before batch logic can preserve them. Automation should call the CLI directly:

```bash
open-bridge launch --root DIR
```

</details>

## Connecting a client

Open Bridge keeps the transport URL and the operating prompt separate.

Get the MCP URL:

```bash
open-bridge url
```

Get the operating prompt:

```bash
open-bridge prompt
```

Configure the URL in your MCP client, connect it, then give the client the prompt.

Clients that require a standard authorization flow can use OAuth 2.1 + PKCE. OAuth is off by default. Configuration details are in [docs/configuration.md](docs/configuration.md#web-console).

## Security

Open Bridge deliberately exposes powerful local capabilities, so its security model is explicit rather than hidden.

- `/api` and `/console` are loopback-only.
- Public access uses the tokenized MCP route.
- OAuth discovery/authorization routes are exposed only when OAuth is enabled.
- The bearer gate is optional and off by default for URL-only client compatibility.
- Exposure is reported as `local`, `public-open`, or `public-authed` in status, health, startup output, and the console.
- File and process operations retain the permissions of the user running Open Bridge.

Read **[SECURITY.md](SECURITY.md)** before exposing an instance to the public internet. It documents the threat model, the three exposure levels, deliberate non-goals, and vulnerability reporting.

## Architecture

Open Bridge is a modular Node.js application rather than a web-framework application.

```text
CLI / TUI / Web console
          │
          ▼
   Bridge subsystems
 tools · runtime · sessions
 tunnel · auth · lifecycle
          │
          ▼
  explicit external boundaries
 filesystem · processes · network
 Windows adapters · MCP transport
```

The design favors:

- a modular monolith over service fragmentation;
- explicit subsystem boundaries over framework layers;
- Ports & Adapters only where an external boundary actually exists;
- structured argv/cwd/env process launches instead of shell interpolation;
- behavior-preserving compatibility facades where migration requires them;
- architecture tests for boundaries that should not regress.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the current module map.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/README.md](docs/README.md) | Documentation hub and source-of-truth map |
| [docs/tunnels.md](docs/tunnels.md) | Beginner ngrok / Tailscale Funnel setup |
| [docs/configuration.md](docs/configuration.md) | CLI commands, console, tunnel, notifications, data directory, FAQ |
| [docs/tools.md](docs/tools.md) | Complete tool reference and exact behavior |
| [SECURITY.md](SECURITY.md) | Threat model, exposure levels, vulnerability reporting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module ownership, execution paths, state and security boundaries |
| [docs/observability.md](docs/observability.md) | Diagnostics, data-directory artifacts, logs, redacted exports |
| [AGENTS.md](AGENTS.md) | Repository engineering conventions |
| [docs/agent-collaboration-workflow.md](docs/agent-collaboration-workflow.md) | Verification, collaboration, and handoff workflow |
| [CHANGELOG.md](CHANGELOG.md) | User-visible changes and rationale |

## Development

```bash
npm ci
npm run dev -- serve --no-tunnel
npm run verify
```

Useful checks:

```bash
npm run check:fast      # security check + typecheck + lint + unit/UI tests
npm run verify          # build + complete test suite
npm run package:check   # inspect the npm package payload
npm run release:check   # complete release preflight
```

Integration tests start the built `bin/open-bridge.js` and speak real HTTP, so rebuild `dist` before running integration tests when source code has changed.

Runtime dependencies are the official MCP packages used for the supported protocol generations and Node transport. MCP, API, OAuth, and console routes are served directly on `node:http`.

## License

MIT © Open Bridge contributors
