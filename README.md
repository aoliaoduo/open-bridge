# Open Bridge

**Give ChatGPT, Claude or Cursor real access to one folder on your machine — files, commands, processes — over a standard MCP endpoint.**

[![CI](https://github.com/aoliaoduo/open-bridge-app/actions/workflows/ci.yml/badge.svg)](https://github.com/aoliaoduo/open-bridge-app/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

English | [简体中文](README.zh-CN.md)

One Node process, one port. No editor, no extension, no web framework.

```bash
npm install -g .        # once, from this repo
cd your-project
open-bridge serve
```

That prints an MCP URL. Paste it into your client and the AI is working in
that directory.

```
Web console:    http://127.0.0.1:18080/console/
Local MCP URL:  http://127.0.0.1:18080/mcp/<route token>
Public MCP URL: https://<your-domain>/mcp/<route token>      ← with ngrok configured
```

> **The URL is the key.** While it is publicly reachable, whoever has it can
> read your files and run commands. Start with `--no-tunnel` if you only need
> it locally, or turn on the bearer gate from the console's Security page.

---

## Why this exists

Editor extensions tie the AI to the editor. This does not: the bridge is a
plain HTTP server, so the same workspace is reachable from a browser tab, a
desktop app, or a phone — anything that speaks MCP.

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

On Windows there is `start-open-bridge.cmd`: double-click it, type the folder
you want, and it installs, builds and opens the console for you.

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

`/api` and `/console` answer loopback only; the public tunnel exposes `/mcp`
and nothing else. The bearer gate ships **off**, because URL-only clients like
the ChatGPT connector cannot send headers and would all break — turn it on
from the Security page when you need it. The app never quietly narrows your
permissions, but it does state your exposure level (`local`, `public-open`,
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
| [AGENTS.md](AGENTS.md) | Conventions for changing this repo — read before a PR |
| [CHANGELOG.md](CHANGELOG.md) | What changed and why |

## Development

```bash
npm install
npm run dev -- serve --no-tunnel   # run from source, no build step
npm run verify                     # typecheck + lint + build + every test
```

`npm run verify` must be green before a commit. Integration tests really start
`bin/open-bridge.js` and speak HTTP, so **build before running them** or they
will report the old behaviour.

Architecture: `src/bridge|http|mcp|network|process|shell|workspace` is a
host-independent core, `src/host/` is the one host abstraction, `src/server/`
is the API and console, `src/cli.ts` is the entry point. Runtime dependencies
are the two MCP SDKs and nothing else — `/mcp`, `/api` and `/console` all sit
directly on `node:http`.

## License

MIT © Open Bridge contributors
