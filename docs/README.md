# Open Bridge Documentation

<div align="center">

**User guides, security boundaries, architecture, and diagnostics for Open Bridge.**

[README](../README.md) · [简体中文 README](../README.zh-CN.md) · [Security](../SECURITY.md) · [Changelog](../CHANGELOG.md)

</div>

---

## Start here

| I want to… | Read |
| --- | --- |
| Get a public MCP URL with ngrok or Tailscale | [Public tunnel quick start](tunnels.md) |
| Install, start, configure, or operate Open Bridge | [Configuration & reference](configuration.md) |
| Understand every MCP tool and result contract | [Tool reference](tools.md) |
| Understand security boundaries before exposing a workspace | [Security policy](../SECURITY.md) |
| Understand module ownership and request flow | [Architecture](ARCHITECTURE.md) |
| Diagnose a broken or suspicious instance | [Observability & diagnostics](observability.md) |

## User documentation

### Public tunnel onboarding

**[Public tunnel quick start](tunnels.md)** is the beginner path from “provider not installed yet” to a verified public MCP URL for ngrok or Tailscale Funnel.

### Configuration & operations

**[Configuration & reference](configuration.md)** is the canonical operational manual.

It covers:

- workspace and multi-instance behavior;
- CLI commands;
- the Web console;
- bearer authentication and OAuth 2.1;
- ngrok and Tailscale Funnel;
- notifications;
- shell, concurrency, and tool-surface controls;
- the data directory and FAQ.

### MCP tools

**[Tool reference](tools.md)** documents the complete tool contract, including:

- how to choose between similar tools;
- structured result conventions;
- pagination and truncation;
- command/process/service lifecycle;
- compatibility aliases;
- modern vs. legacy MCP session behavior.

### Security

**[SECURITY.md](../SECURITY.md)** is the source of truth for the threat model and exposure levels.

Read it before running a public tunnel. Open Bridge intentionally grants powerful local capabilities; the security document distinguishes protected boundaries from deliberate product choices.

### Diagnostics

**[Observability & diagnostics](observability.md)** explains which surface to use for which failure:

```text
Environment problem     → open-bridge doctor
Live instance problem   → open-bridge health
MCP runtime state       → bridge_status
Issue / support bundle  → open-bridge diagnostics
```

## Engineering documentation

**[Architecture](ARCHITECTURE.md)** describes the current module map, state ownership, security boundaries, and execution paths.

Repository contributors should also read:

- [CONTRIBUTING.md](../CONTRIBUTING.md) — contribution and verification entry point;
- [AGENTS.md](../AGENTS.md) — implementation conventions and test evidence rules;
- [Agent collaboration workflow](agent-collaboration-workflow.md) — optional MCP-assisted execution workflow;
- [Release process](release.md) — maintainer release procedure.

Internal product/design notes live beside these documents but are not part of the user-facing contract.

## Sources of truth

When two documents appear to overlap, use this ownership rule:

| Topic | Canonical source |
| --- | --- |
| Product overview / quick start | [README.md](../README.md) |
| First-time public tunnel setup | [tunnels.md](tunnels.md) |
| Runtime configuration and operations | [configuration.md](configuration.md) |
| Tool behavior and schemas | [tools.md](tools.md) |
| Threat model and vulnerability reporting | [SECURITY.md](../SECURITY.md) |
| Module ownership and dependency boundaries | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Diagnostics and data-directory artifacts | [observability.md](observability.md) |
| Contributor verification rules | [AGENTS.md](../AGENTS.md) |
| User-visible release history | [CHANGELOG.md](../CHANGELOG.md) |
