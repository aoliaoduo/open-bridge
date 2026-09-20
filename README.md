# Open Bridge

**Give ChatGPT, Claude or Cursor real access to one folder on your machine — files, commands, processes — over a standard MCP endpoint.**

[![CI](https://github.com/aoliaoduo/open-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/aoliaoduo/open-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

English | [简体中文](README.zh-CN.md)

One Node process, one port. No editor, no extension, no web framework.

```bash
npm ci                 # once, from a checkout of this repo
npm run build
npm install -g .
cd your-project
open-bridge serve
```

That prints an MCP URL. Paste it into your client and the AI is working in
that directory.

```
Web console:    http://127.0.0.1:18080/console/
Local MCP URL:  http://127.0.0.1:18080/mcp/<route token>
Public MCP URL: https://<your-domain>/mcp/<route token>      ← with a public tunnel configured
```

> **The URL is the key.** While it is publicly reachable, whoever has it can
> read your files and run commands. Start with `--no-tunnel` if you only need
> it locally, or turn on the bearer gate from the console's Security page.

---

## Why this exists

Editor extensions tie the AI to the editor. This does not: the bridge is a
plain HTTP server, so the same workspace is reachable from a browser tab, a
phone, or any other MCP-capable client.

- **39 tools** — read, write, patch, search, run commands, supervise
  long-running processes, orchestrate named services.
- **Two MCP protocol generations on one endpoint**, chosen per request. Old
  clients keep working; nothing to configure.
- **A real console** at `/console/` — sessions, tools, logs, locks, health,
  every setting. Not a status page: things are actually operated from it.
- **It tells you when it needs you.** Phone push (Bark) or a sound on this
  machine, when the AI is blocked on an answer or the conversation ends.

## Getting started

Three things worth knowing on day one:

**The workspace is the directory you started in.** No config file, no
dropdown. Run it in another folder to get a second, independent instance.

**Ports move unless you pin them.** Without `--port` the bridge takes a random
free port, so the URL changes each start. `--port 18080` keeps it stable.

**Closing the terminal stops the bridge.** That window owns the instance —
which is also why the console has no start/stop buttons.

On Windows, `start-open-bridge.cmd` asks which folder to serve. For this
repository itself, double-click `start-open-bridge-project.cmd`: it always uses
this project as the workspace, rebuilds it, and serves the console on fixed
port **8123** (without opening a browser).

Everything else — every command, every setting, the console tour, the tunnel,
notifications, the data directory — is in
**[docs/configuration.md](docs/configuration.md)**.

## Connecting a client

```bash
open-bridge prompt      # prints a ready-made connection message
```

Paste that where your client accepts it, or just give it the MCP URL. For
clients that only accept a standard authorization flow, OAuth 2.1 with PKCE is
available and off by default — see
[docs/configuration.md](docs/configuration.md#web-console).

## Security in one paragraph

`/api` and `/console` answer loopback only. The public side serves the
tokenized MCP and health routes, plus authorization/discovery routes when
OAuth is enabled. The bearer gate ships **off** to support URL-only clients;
turn it on from the Security page when you need individually issued tokens.
The app never quietly narrows your permissions, but it does state your exposure level (`local`, `public-open`,
`public-authed`) in `status`, in `health`, in the console and at startup.

Threat model, the three exposure levels, and **what is deliberately left
unlocked** are in [SECURITY.md](SECURITY.md), which is also where to report a
vulnerability.

## Documentation

| | |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | Commands, console, tunnel, notifications, data directory, FAQ |
| [docs/tools.md](docs/tools.md) | All 39 tools and their exact behaviour |
| [SECURITY.md](SECURITY.md) | Threat model and reporting |
| [AGENTS.md](https://github.com/aoliaoduo/open-bridge/blob/main/AGENTS.md) | Conventions for changing this repo — read before a PR |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current module ownership, execution and state boundaries |
| [Agent workflow](https://github.com/aoliaoduo/open-bridge/blob/main/docs/agent-collaboration-workflow.md) | Repository collaboration, verification and handoff |
| [CHANGELOG.md](CHANGELOG.md) | What changed and why |

## Development

```bash
npm ci
npm run dev -- serve --no-tunnel   # run from source, no build step
npm run verify                     # typecheck + lint + build + every test
```

`npm run verify` must be green before a commit. Integration tests really start
`bin/open-bridge.js` and speak HTTP, so **build before running them** or they
will report the old behaviour.

Run `npm run release:check` for the complete verification plus npm package
preflight. The module map lives in [ARCHITECTURE.md](ARCHITECTURE.md): core
modules depend on the `Host` interface, not its concrete implementation;
using Node built-ins is intentional. Runtime dependencies are three official
MCP packages (the v1 SDK, v2 server and Node adapter), not a web framework;
MCP, API and console routes all sit directly on `node:http`.

## License

MIT © Open Bridge contributors
