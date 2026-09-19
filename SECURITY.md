# Security

## What this tool is

Open Bridge gives an AI client read/write access to files, a shell, and
long-running processes on the machine it runs on. That is the feature, not a
side effect. Everything below describes where the boundaries actually are, so
you can decide whether those boundaries suit you before you point it at
anything you care about.

## Threat model

**In scope.** The operator runs the bridge deliberately and wants a specific AI
client to reach a specific workspace. The risks worth defending against are:
another program on the same machine reading the route token out of the console
API; someone on the internet finding the public tunnel URL and using it; a
secret ending up in a log file or an audit line where it outlives the session.

**Out of scope.** The AI client itself is trusted. There is no sandbox, no
per-tool confirmation prompt, and no attempt to decide whether a command the
model asked for is a good idea. If you would not hand the model a terminal on
this machine, do not connect it. Prompt injection through file contents the
model reads is a real risk and is *not* mitigated here.

## Exposure levels

`status`, `health` and the console all report which of these you are in:

| Level | Meaning |
| --- | --- |
| `local` | No tunnel. The MCP endpoint is reachable only from this machine. |
| `public-open` | A tunnel is up and the endpoint takes any request that knows the URL. The route token in the URL is the only thing standing between the internet and your workspace. |
| `public-authed` | A tunnel is up and Bearer auth is on. Requests need a token you issued. |

`doctor` and `health` treat `public-open` as a warning, not an error -- it is a
legitimate way to run this, and it is also the state most likely to surprise
someone who forgot the tunnel was on.

## What is deliberately not locked down

- **`unrestrictedFileAccess` defaults to on.** Absolute paths outside the
  workspace are reachable. This is a personal tool for a machine you own, and
  clamping it would break the case where you ask the AI to look at a file in
  another directory. The workspace root anchors *relative* paths; it is not a
  jail. What is refused is the operation nobody means to issue: a `delete` or
  `move` landing on the workspace root, the data directory (`~/.open-bridge`)
  or a drive root. `run_command` remains the deliberate way to do it anyway.
- **Non-zero exit codes are not failures.** Commands run; their exit codes are
  reported, not judged.
- **Tool behaviour hints** (`readOnlyHint`, `destructiveHint`, ...) are
  information for the client. The bridge does not refuse, filter or add
  confirmation steps based on them.

## What is protected

- **The route token is not a password, it is an address** -- but it is still
  the thing that makes a `public-open` tunnel yours. It is derived from the
  workspace path, so the same directory keeps the same URL. Three read-only
  `/api` endpoints return it (`settings`, `prompt`, `status`), which is why
  CORS is granted only to `/mcp`, `/oauth` and `/.well-known`, never to `/api`
  or `/console`. A page in your browser cannot read it cross-origin.
- **The console and `/api` are loopback-only**, and writes additionally require
  a header no cross-origin request is allowed to send.
- **Secrets are masked on the way out, not just on the way in.** The Bark
  device key is write-only: `get_config`, the settings view, audit summaries
  and log lines show a shape (`<set:N chars>`), never the value. Audit lines go
  through the same redaction as everything else and are capped at 500
  characters (`state.ts`). The log lives in `~/.open-bridge/` and rotates at
  `logMaxBytes`, 10 MB by default.
- **Audit log.** Every tool call is recorded with its arguments summarised,
  redacted and truncated. Failures record why they failed.

## Supported versions

Pre-1.0. Fixes land on `main` and go out in the next release; there are no
backported patch branches yet.

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/aoliaoduo/open-bridge/security/advisories/new)
for anything that lets a party other than the operator reach the workspace, or
that exposes a secret the masking above is supposed to cover. Those get
priority over the issue tracker.

Please do **not** file a report for the documented behaviours in "What is
deliberately not locked down" -- they are choices, and the reasoning is above.
If you think a choice is wrong, an issue arguing the case is welcome.
