# Configuration and reference

Everything the README deliberately leaves out. The README answers "what is
this and how do I start it"; this file answers "what are all the knobs".

> 这份参考文档目前只有英文版。中文 README 链到这里是有意的：把它翻译一遍，
> 就等于让两份文档各自漂移 —— 设置项改了而翻译没跟上，比只有一种语言更糟。
> （This reference is English-only for now. The Chinese README links here on
> purpose: maintaining a translation of a settings reference means the two
> drift apart, which is worse than one language.）

- [The workspace is the directory you started in](#the-workspace-is-the-directory-you-started-in)
- [Commands](#commands)
- [Web console](#web-console)
- [Choosing a tunnel](#choosing-a-tunnel-the-settings-page-does-the-choosing-for-you)
- [Public tunnel (ngrok)](#public-tunnel-ngrok)
- [Public tunnel (Tailscale Funnel)](#public-tunnel-tailscale-funnel)
- [Notifications](#phone-notifications-bark)
- [Data directory](#data-directory)
- [FAQ](#faq)

---

## The workspace is the directory you started in

No configuration file, no dropdown: **the workspace of `open-bridge serve` is the directory it was launched from**.

```bash
cd /path/to/project-a
open-bridge serve --port 18080        # this instance serves project-a

cd /path/to/project-b
open-bridge serve                     # a second instance, serving project-b, independent
```

- Both can run **at once**, each with its own port, route token and runtime record. Relative paths (`read_files({paths:["src/index.ts"]})`) always resolve against that instance's own directory.
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
| `open-bridge stop [--pid N]` | Stop the instance for the current directory — or, with `--pid`, exactly the instance that pid names, from any directory |
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
| Sessions | `/console/sessions` | Stateful clients show handshake/idle/todo facts and can be disconnected; the stateless modern-client activity row cannot be disconnected as a session |
| Tools | `/console/tools` | The `tools/list` this instance actually publishes, after profile filtering; core tools highlighted, searchable |
| Health | `/console/health` | Instance, workspace, tools, build, tunnel and exposure checked one by one, including a real `/healthz` request through the tunnel. Read-only diagnosis; exposure problems are fixed on the Security page |
| Services | `/console/services` | Save, start, stop and restart local service definitions |
| Tasks | `/console/todos` | Session/persisted task lists and their latest progress, written through MCP |
| Logs | `/console/logs` | Live log stream over SSE; the full audit trail is `audit.log` in the data directory |
| Stats | `/console/stats` | Call counts, distribution by tool, recent activity |
| Security | `/console/security` | Exposure overview, bearer gate (issue and enable in one click), personal tokens — create, rotate, revoke, delete, purge — and OAuth 2.1. The old `/console/tokens` path redirects here |
| Settings | `/console/settings/…` | Seven subpages: `tunnel` / `network` / `files` / `shell` / `notify` / `locks` / `logs`. Deep-linkable, and sharing one validation layer with the MCP `get_config` / `set_config_value` tools |

The frontend router owns these paths (`ui/src/routes.ts`); the server returns the same page for any `/console/*` and injects the token, so adding a page needs no server change.

### Security boundaries

- `/api` and `/console` **answer loopback hosts only** (`127.0.0.1`, `localhost`). Reaching them through a public tunnel gets a 403. Tokenized MCP and health routes are public; enabling OAuth also exposes its authorization/discovery endpoints.
- **CORS headers go to `/mcp`, `/oauth` and `/.well-known` only** — never to `/api`, `/console` or `/healthz`. The console is same-origin and never needed CORS, while three read-only `/api` endpoints return this instance's MCP address, **route token included** (`settings` in `state.mcpUrl`, `prompt` in its text, and `status`). One `Access-Control-Allow-Origin: *` would let any page open in your browser read it locally — the loopback check cannot stop a page inside the same browser, and private-network rules are vendor policy rather than specification.
- Every write requires an `X-Open-Bridge-Console` header matching the route token. The server injects it into the page; a cross-site page can neither read nor send it.
- **The bearer gate is off by default** to preserve URL-only client access. Enable individually issued credentials from the Security page: issue a token and flip the switch, or use **"issue a token and enable the gate"** to do both at once (an existing token is reused; the plaintext is shown once). With the gate on and no valid token, it **fails closed**. The local console can always turn it back off, so you cannot lock yourself out.
- Issued tokens are permanent unless a lifetime is configured: `auth.tokenTtlSeconds` (default `0` = never expire, ceiling 2^31) applies to newly minted tokens.
- **Publicly reachable means whoever has the URL can read and write your files and run commands.** The app will not quietly restrict your permissions, but it says this everywhere: `status`, the console, `health`, and the startup banner. To tighten it, enable the bearer gate — or run `--no-tunnel` and stay local.

> The full threat model, the three exposure levels, and **what is deliberately left unlocked** (`unrestrictedFileAccess` defaults on, exit codes are not verdicts, behaviour hints are information rather than limits) are in [`SECURITY.md`](../SECURITY.md), which is also where vulnerability reports go.

### OAuth 2.1 (optional, off by default)

Some MCP clients only accept a standard authorization flow and will not take a token in a URL. With OAuth enabled, such a client registers itself and obtains **its own** credentials over OAuth 2.1 with PKCE:

```bash
open-bridge config set oauth.enabled true
```

The settings page does the same thing. Once on, a client discovers the server at `/.well-known/oauth-protected-resource`, registers at `/oauth/register`, and is sent to `/oauth/authorize` — **that page asks for your route token** (the string in the MCP URL; `OPEN_BRIDGE_OAUTH_OWNER` can replace it with a different passphrase) — and then receives access and refresh tokens.

- **Off by default.** Once enabled, `/mcp` requires a valid OAuth or personal bearer credential; the route token alone no longer suffices. An unauthenticated, OAuth-capable client receives 401 plus `WWW-Authenticate` to begin authorization, then obtains **individually revocable** credentials. The path token still selects the instance; it is not a substitute for this authentication.
- **Clients holding tokens keep working.** `Authorization: Bearer <token>` and `?token=<token>` still pass, whether or not the personal-token gate is on. For a client that only takes a URL and cannot send headers, give it a `?token=<token>` address, or leave OAuth off.
- **Visible and reversible from the console.** The OAuth 2.1 card is the switch, and it lists registered clients and how many credentials are live. `/api` and `/console` stay loopback-only, so the switch is always reachable.
- **S256 only.** `plain` is refused: these are public clients with no secret, and PKCE is the only proof of possession.
- **`resource` is required and must be this host**, otherwise a token issued here could be replayed against another service (RFC 8707).
- **Refresh tokens rotate once.** A used refresh token is dead immediately, so a replay buys nothing.
- OAuth exposes metadata, authorize, register, token and revoke endpoints publicly. `/api` and `/console` remain loopback-only, and what the console reads (`/api/oauth`) contains **no secrets or digests**.
- `oauth.allowedRedirectHosts` (default `[]` = the built-in list) adds extra redirect hosts a dynamically registered client may use.

---

## Choosing a tunnel (the settings page does the choosing for you)

Both providers publish the same thing — `https://<host>/mcp/<route-token>` — and
the console renders them as **one card with three parts**, in the same order,
whichever provider is selected:

```
[1] 提供商        ▾ ngrok / Tailscale Funnel / none
[2] 状态与操作     ● 公网地址已发布 https://…      [一键自动配置] [重新检测] [测试公网可达]
                   └ 只读摘要：装了没有、登录没有、域名/保留域名几个、443 现在归谁
[3] 高级设置       可执行文件 ▾ / 手填的公网地址 / Authtoken / 系统代理 / 自动重连   （默认收起）
```

| 你想让谁访问 | 选哪个 | 你需要准备什么 |
| --- | --- | --- |
| 只有这台机器 | `none` | 什么都不用；不做隧道 |
| 公网、有自己的域名 | ngrok | 一个 ngrok 账号 + authtoken（本机跑过一次 `ngrok config add-authtoken` 就够） |
| 公网、已经有 Tailscale | Tailscale Funnel | 装好并登录 Tailscale、启用 Funnel；本实现使用 HTTPS 443 |

- **一键自动配置** is one click and it says what it will do *before* you press it:
  the line under the button lists the exact writes (`ngrokExecutable=…`,
  `公网地址=…`, `ngrok authtoken（从本机 ngrok 配置导入）`). It only ever fills
  fields that are still **empty** — a value you typed is reported as 保持不变 and
  left alone. After writing, a running tunnel is rebuilt so the new values take
  effect now rather than at the next restart.
- **重新检测** re-runs the reconnaissance (install / login / reserved domains /
  who holds 443). The page caches it for a minute, because producing it spawns
  the provider CLIs and, with a token, calls ngrok's API.
- **测试公网可达** runs the same checks as `open-bridge health`, including a real
  `/healthz` request **through the tunnel**, and shows the three rows that decide
  a verdict (隧道 / 公网连通 / 暴露面) plus the next step when something fails.
- **Reconnaissance is read-only.** It never writes ngrok's or tailscale's own
  configuration, and it never turns a funnel on. Configuration changes are
  explicit actions. Starting or stopping Funnel also changes the daemon's
  mount through the Tailscale CLI; that is not read-only detection. The
  authtoken never travels to the page — it is
  reported as its source ("已保存在凭据库" / "可以从本机 ngrok 配置导入") and, when
  imported, read server-side.
- **Advanced settings** contain the executable pickers, editable domain,
  authtoken, proxy switch and auto-reconnect. The reserved-domain dropdown is
  optional: the domain remains editable when an account API listing is
  unavailable.
- **The reserved-domain dropdown needs an ngrok *API key*, not your authtoken.**
  ngrok keeps the two credentials apart on purpose: the authtoken opens tunnels,
  and `api.ngrok.com` refuses it outright (`ERR_NGROK_206` — "the authentication
  you specified is actually an authtoken ... check your records for an API key").
  The card reads `api_key:` out of ngrok's own config (one line, from
  <https://dashboard.ngrok.com/api-keys>) and only then asks for the list; without
  one it says which credential is missing and the field stays typable, which is a
  normal state rather than a fault — a machine that only ever ran
  `ngrok config add-authtoken` has a working tunnel and no list to show.
- **A Store install of ngrok is found too.** ngrok from the Microsoft Store
  reaches PATH as an *App Execution Alias*: `…\Microsoft\WindowsApps\ngrok.exe`
  is a reparse point that CreateProcess resolves and `stat` — hence `existsSync` —
  cannot follow. That path now counts as installed, the picker labels it
  PATH（Microsoft Store 版）so it is not mistaken for the zip someone unpacked
  themselves, and the alias directory is offered even when PATH omits it.
- The card is backed by `GET /api/tunnel` (facts + the plan 「自动配置」 would run,
  in one object, so the promise and the write cannot drift). It carries no
  credential. `/api` stays loopback-only.

## Public tunnel (ngrok)

Local-only access? Add `--no-tunnel` and skip ngrok entirely. The built-in listener binds to loopback; this does not expose a LAN listener.

To let an external client such as ChatGPT on the web reach you:

ngrok needs your account authtoken once before it will open a tunnel. Paste it into **Settings → Tunnel** in the console and save — or run `ngrok config add-authtoken <token>` if you prefer the terminal; either works, and the console entry exists so that a first run does not require one.

```bash
open-bridge config set ngrokDomain <your-reserved-domain>.ngrok-free.dev
open-bridge serve                 # note: without --no-tunnel; --open is optional
```

- Account/domain quotas are determined by ngrok. **One reserved domain can only be held by one instance at a time**. You do not have to stop the instance already holding it: the local instance registry (`bridge-peers.json`) is shared, so the tunnel holder looks up the token digest and forwards to the right instance. A new instance appends its row to the **existing** registry — it never fabricates one in someone else's directory — public requests arrive through that tunnel, `tunnel_role` reads `follower`, and the console notes that this address depends on another instance. When the holder exits, the next probe promotes this instance to `owner`.
- Claiming a domain is deliberately cautious: **only an explicit "nobody holds this" from ngrok counts as free**. Timeouts and 5xx mean "unknown" and it keeps watching. On `ERR_NGROK_334` (already taken) the instance serves locally, keeps watching that tunnel, and switches to `follower` the moment it sees traffic forwarded to it — it neither wedges itself nor starts a second ngrok to fight the first.
- A missing or misspelled domain produces a clear error such as `ERR_NGROK_313`; the local service is unaffected.
- Knobs: `ngrokUseHttpProxy` (default `true`) sends the ngrok agent through the system HTTP proxy; `publicHealthTimeoutMs` (default 20000) bounds the public-URL health check; `autoReconnect` (default `true`) re-dials the tunnel after a drop.

---

## Public tunnel (Tailscale Funnel)

The other public-tunnel provider. Where ngrok serves a domain you reserved, Tailscale serves **your machine's own stable ts.net hostname** - `https://<machine>.<tailnet>.ts.net/...` - with automatic TLS. Useful when you already run Tailscale and do not want a second account.

Enable Funnel for the tailnet using Tailscale's setup flow at <https://login.tailscale.com/f/funnel>. This Bridge implementation uses HTTPS 443; the tailnet policy and provider's current limits still apply.

```bash
open-bridge config set tunnelProvider tailscale
open-bridge serve                 # without --no-tunnel
```

- The machine's ts.net name is discovered from `tailscale status --json` at tunnel start and stored into `tailscaleDomain` (you can set it manually with `open-bridge config set tailscaleDomain <name>`; a stored value that disagrees with what the CLI reports is an error, not a silent mismatch).
- No authtoken: the CLI talks to the local daemon, which holds your login.
- The public URL follows the same shape as ngrok's: `https://<machine>.<tailnet>.ts.net/mcp/<route-token>`.
- Stopping the instance turns the funnel off (`tailscale funnel --https=443 off`) — only when the 443 mount still points at this instance. A follower, or an instance whose mount was replaced while it ran, leaves the daemon's config alone on its way out: switching off a peer's public access is worse than leaving a stale mount, and the next claim replaces a stale mount anyway.
- Tailscale forwards the client IP in `X-Forwarded-For` (appended, same as ngrok), so the auth failure limiter works the same way.
- The CLI is found the way ngrok's is: `tailscaleExecutable` wins when set, otherwise PATH, otherwise the MSI's default install dir (`C:\Program Files\Tailscale\tailscale.exe` — the MSI does not put `tailscale` on PATH, so on Windows this fallback is the common case, not a curiosity). Leave the setting empty to let the resolver decide.
- **Bridge instances share the HTTPS 443 mount.** This implementation uses 443 and the daemon keeps one mount per port, so two Bridge instances in tailscale mode cannot both hold it — and no longer try: the second instance reads the daemon's mount (`funnel status --json`, whose backend port is the holder's listener), finds a live holder behind it and FOLLOWS it rather than replacing it. The two addresses still both work: the holder's listener looks the other instance's token up in the shared registry (`bridge-peers.json`) and forwards to it — the same mechanism the ngrok section describes, and the reason that registry is shared. When the mount is released — the holder stopped, or died without running `funnel off` and left a mount pointing at a dead port — the follower's watch (same cadence and same two-round rule as ngrok) claims it and becomes the owner. The one asymmetry left with ngrok is deliberate: an OWNER does not watch its own mount. ngrok's tunnel is a child process this instance owns, so its exit arms a reconnect; the funnel mount is daemon-side state that outlives this process, and nothing in-process notices if the daemon loses it — `Start`, or a provider switch, rebuilds it.
- Tailscale not installed or not logged in? The start logs `tailscale status failed` and the instance stays local-only; the error names the cause.
- `sharedPeerRegistry` (default `""`) points at an explicit peer-registry file instead of the discovered one; leave it empty unless a peer's registry lives outside the standard data directories.

---

## Phone notifications (Bark)

You do not have to watch the tab while a web AI works. Paste the link the Bark app shows (`https://api.day.app/<device key>/…` — the whole thing; the key is extracted) into **Settings → Phone notifications** in the console.

Notifications are deliberately limited to two moments that genuinely need a person: the AI is **waiting for an answer or choice**, and an exchange is **finished**. A single activity episode gets at most one alert. Bark delivery is fixed to `level=timeSensitive&call=1`; `call=1` is one persistent Bark alert, and Open Bridge never sends a server-side repeat.

- Task completion and ordinary progress never notify the phone. The server does retain one conservative fallback for an agent that forgets to announce an ending, but it waits **ten full minutes** of quiet activity first; it never repeats.
- When an agent asks a blocking question it sends `waiting` once; on a genuine ending it sends `finished` once.
- The key only goes one way: the console and `get_config` show a mask; the audit and runtime logs never contain it. `notify.serverUrl` can point at a self-hosted Bark (plain http is allowed on loopback only).
- A configured local sound uses the same two-event, once-per-episode rule and does not require Bark; its keys are `sound.enabled` (default `false`), `sound.fileWaiting` and `sound.fileFinished` (empty = unset).
- Config keys: the pasted link fills `notify.barkKey`, and `notify.enabled` (default `true`) is only a mute switch — an unset key is already off.

---

## Shell, concurrency and tool surface

Knobs without a settings card; set them with `open-bridge config set` or the config file.

- `shellPath` / `shellArgs` (defaults `""` / `[]`) override the shell behind `run_command`, `open_shell` and `run_script`; empty means the platform default — the bundled Git Bash on Windows.
- `concurrency.enabled` (default `true`) turns the one-caller queue on; `concurrency.holdTimeoutMs` (default 300000) bounds how long a call may hold the slot, `concurrency.waitTimeoutMs` (default 120000) how long the next caller waits in line.
- `toolProfile` (default `"full"`; the other value is `"core"`) selects which tools `tools/list` advertises.
- `allowedDirectories` (default `[]`) matters only when `unrestrictedFileAccess` is off: file tools are then limited to the workspace root plus these absolute directories (the Settings page exposes the same list, one per line).

---

## Data directory

Defaults to `~/.open-bridge`; `OPEN_BRIDGE_HOME` or `--home` changes it.

```
config.json              Configuration (canonical defaults in config-defaults.ts)
state.json               Persistent state: service definitions, todos, usage counters
secrets.json             Persisted per-workspace route tokens and hashed personal-token records
audit.log                Append-only audit log, rotating at 1 MiB
logs/bridge.log          Bridge log, read by `open-bridge logs`; rotates at 10 MiB
                         to bridge.log.1 (`logMaxBytes` adjusts it, 0 disables rotation)
service-logs/            Per-workspace saved-service logs (5 MiB rotation; log_file may override path)
runtime-<suffix>.json     One runtime record per workspace: pid, port, root
bridge-peers.json        Local instance registry, used when instances share a tunnel
```

Instances sharing a data directory share **configuration, tokens and the registry**, while **runtime records and route tokens are per workspace** (the runtime suffix identifies the workspace; the route token is separately generated and persisted, not derived from that suffix).

> Upgrading: an older single `runtime.json` is still read, but only when the root it records is the one being looked for — so an instance for directory A is never mistaken for one for B.

---

## FAQ

**Port already in use?**
The refusal names the holder — pid and the directory it serves — and offers the way out: `open-bridge stop --pid <pid>` stops exactly that instance (from any directory), or `--port 18081` starts this one elsewhere. `open-bridge instances` lists every running instance. When no Bridge instance holds the port, the refusal points at the platform's own owner check (`netstat -ano | findstr :<port>` on Windows, `lsof -i :<port>` elsewhere) instead of sending you to `stop` for something that is not a Bridge.

**The public address does not respond?**
`open-bridge health` makes a real request over the public URL and reports status and timing. `tunnel_role: follower` means the address is borrowed from another instance; it will change when that instance exits, and this one takes over when it can.

**The MCP client reports a transport error (SSL EOF, connection reset, timeout)?**
A transport interruption is not a tool failure. Wait five seconds and retry once for a safe read or connection request. If a command or write might already have started, inspect its process/activity/file state first; use the existing `command_id` to resume rather than launch a duplicate. Long commands should use `background:true`.

**Worried about being wide open?**
`status`, `health` and the console all state the current exposure level (`local`, `public-open`, `public-authed`). To tighten it, issue a token on the Security page and enable the bearer gate; to avoid exposure entirely, use `--no-tunnel`.

---
