# Public tunnel quick start / 公网隧道小白教程

[Documentation](README.md) · [Configuration](configuration.md) · [Security](../SECURITY.md)

Open Bridge runs the workspace locally, but the normal client connection is a public HTTPS MCP URL published through **ngrok** or **Tailscale Funnel**.

> The Web console always stays local. The tunnel publishes the MCP endpoint, not the local administration UI.

## Choose a provider

| If you are… | Recommended |
| --- | --- |
| New to both providers and want the shortest setup | **ngrok** |
| Already using Tailscale on this machine | **Tailscale Funnel** |
| Testing only on the same machine | No tunnel / `--no-tunnel` |

A successful remote setup ends with all three of these being true:

1. **Settings → Tunnel** shows a public HTTPS address.
2. **Test public reachability** passes.
3. `open-bridge status` / `open-bridge health` reports `public-open` or `public-authed`, not `local`.

---

## ngrok — first-time setup

ngrok is usually the easiest choice when you do not already use Tailscale.

### 1. Create an ngrok account

Create an account at [ngrok](https://ngrok.com/).

Your account provides:

- an **authtoken**, which lets the ngrok agent authenticate;
- a development/reserved domain, which Open Bridge uses as its stable public hostname.

### 2. Install the ngrok agent

Official download page: [ngrok download](https://ngrok.com/download)

Windows:

```powershell
winget install ngrok -s msstore
```

macOS with Homebrew:

```bash
brew install ngrok
```

Linux users should follow the package instructions on the official download page.

Check that the command works:

```bash
ngrok version
```

If that prints a version, installation is complete.

### 3. Add the authtoken once

Copy the authtoken from your ngrok account and run:

```bash
ngrok config add-authtoken "<YOUR_AUTHTOKEN>"
```

You only need to do this once per machine/account.

Open Bridge can import this credential server-side when you click **Auto-configure**. You can also paste the authtoken directly under **Settings → Tunnel → Advanced settings**.

### 4. Start Open Bridge

From the project directory:

```bash
open-bridge serve
```

Do **not** add `--no-tunnel`.

Open the local Web console URL printed in the terminal, then go to:

**Settings → Tunnel**

Choose **ngrok**.

### 5. Detect and auto-configure

Use these buttons in order:

1. **Detect again**
2. **Auto-configure**

Open Bridge will try to:

- find the installed ngrok executable;
- import the existing ngrok authtoken;
- fill the public hostname when it can discover exactly one account domain.

#### If “Public address” is still empty

Open Bridge currently requires an explicit ngrok hostname. An empty hostname means **local-only**; it does not start a random ngrok URL.

Open the [ngrok dashboard](https://dashboard.ngrok.com/), find your account's development/reserved domain, and paste only the hostname into **Public address**, for example:

```text
example.ngrok-free.app
```

Do not paste `https://` and do not append `/mcp/...`.

> The ngrok **authtoken** is enough to open a tunnel, but listing domains through ngrok's account API requires an **API key**. If Auto-configure cannot populate the domain list, manually pasting the hostname is the simplest path; you do not need an API key just to use the tunnel.

### 6. Verify the public endpoint

In the Tunnel card click:

**Test public reachability**

Then run:

```bash
open-bridge health
open-bridge url
```

Success looks like:

- tunnel: healthy;
- exposure: `public-open` or `public-authed`;
- MCP URL begins with `https://`, not `http://127.0.0.1`.

Copy that public MCP URL into ChatGPT, Claude, or your other remote MCP client.

### ngrok troubleshooting

| Symptom | What to do |
| --- | --- |
| “ngrok not found” | Install ngrok, then click **Detect again**. |
| “authtoken: none” | Run `ngrok config add-authtoken ...` or paste it in Advanced settings. |
| Public address is empty | Copy the development/reserved hostname from the ngrok dashboard and save it manually. |
| Tunnel stays local | Confirm the provider is `ngrok`, Public address is non-empty, then restart/start the tunnel. |
| Public reachability fails | Run `open-bridge health` and read the tunnel row before changing settings. |

---

## Tailscale Funnel — first-time setup

Choose Tailscale Funnel when this machine already uses Tailscale or you prefer a stable `*.ts.net` hostname managed by Tailscale.

Official install page: [Tailscale download](https://tailscale.com/download)

Official Funnel documentation: [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)

### 1. Install and log in to Tailscale

Install Tailscale, open the client, and sign in.

Check the CLI:

```bash
tailscale status
```

If it lists this machine/tailnet instead of asking you to authenticate, login is ready.

On systems where the CLI is not on `PATH`, Open Bridge can detect common installation locations automatically.

### 2. Enable Funnel for the tailnet

Funnel is not the same thing as normal Tailscale access: Funnel makes the service reachable from the **public internet**.

Use Tailscale's setup flow:

<https://login.tailscale.com/f/funnel>

Approve Funnel for your tailnet.

Open Bridge uses the machine's `*.ts.net` name and HTTPS port **443**.

> Tailscale's requirements and supported client variants can change. If Funnel activation fails, check the official Funnel documentation linked above. On platforms where Funnel is unavailable, use ngrok instead.

### 3. Start Open Bridge

From the project directory:

```bash
open-bridge serve
```

Open the local Web console and go to:

**Settings → Tunnel**

Choose **Tailscale Funnel**.

### 4. Detect and auto-configure

Use:

1. **Detect again**
2. **Auto-configure**

Open Bridge will:

- locate the Tailscale CLI;
- verify that the node is logged in;
- discover the machine's `*.ts.net` name;
- publish the local Bridge listener through Funnel on HTTPS 443.

You normally do **not** need to type the Tailscale domain manually.

### 5. Verify the public endpoint

Click:

**Test public reachability**

Then run:

```bash
open-bridge health
open-bridge url
```

Success looks like:

```text
https://<machine>.<tailnet>.ts.net/mcp/<route-token>
```

The exposure should be `public-open` or `public-authed`.

### Tailscale troubleshooting

| Symptom | What to do |
| --- | --- |
| “Tailscale not found” | Install the Tailscale client, then click **Detect again**. |
| CLI exists but not logged in | Sign in with the client or run `tailscale up`, then detect again. |
| Funnel not enabled | Complete <https://login.tailscale.com/f/funnel>. |
| Public test fails on 443 | Check Funnel status and whether another non-Bridge service owns the 443 Funnel mount. |
| Domain mismatch after renaming the machine | Clear the saved Tailscale domain so Open Bridge can rediscover the current `*.ts.net` name. |

---

## After either provider works

The public URL is a powerful capability URL:

```text
https://<public-host>/mcp/<route-token>
```

If your MCP client supports authentication, use **Security** in the local Web console to enable Bearer auth or OAuth.

Exposure meanings:

| Status | Meaning |
| --- | --- |
| `local` | No working public tunnel. |
| `public-open` | Public tunnel works; possession of the tokenized MCP URL grants access. |
| `public-authed` | Public tunnel works and Bearer authentication is enabled. |

The local Web console remains loopback-only even when the MCP endpoint is public.

For provider ownership, multi-instance sharing, proxy settings, reconnect policy, and other advanced details, continue with [Configuration and reference](configuration.md#choosing-a-tunnel-the-settings-page-does-the-choosing-for-you).

---

# 中文速查

如果你只想照步骤做，不看英文说明：

### ngrok

1. 注册 ngrok 账号。
2. 安装 ngrok；Windows 可运行 `winget install ngrok -s msstore`。
3. 运行 `ngrok config add-authtoken "<你的 authtoken>"`。
4. 在项目目录运行 `open-bridge serve`。
5. 打开本机 Web 控制台 → **设置 → 隧道 → ngrok**。
6. 点 **重新检测** → **一键自动配置**。
7. 如果“公网地址”还是空的，去 ngrok 后台复制你的 development/reserved domain，只填写域名，例如 `example.ngrok-free.app`。
8. 点 **测试公网可达**。
9. 运行 `open-bridge url`，把得到的 `https://...` MCP URL 配给远程客户端。

### Tailscale Funnel

1. 安装并登录 Tailscale。
2. 运行 `tailscale status` 确认已经登录。
3. 打开 <https://login.tailscale.com/f/funnel>，完成 Funnel 授权。
4. 在项目目录运行 `open-bridge serve`。
5. 打开 Web 控制台 → **设置 → 隧道 → Tailscale Funnel**。
6. 点 **重新检测** → **一键自动配置**。
7. 点 **测试公网可达**。
8. 运行 `open-bridge url`，正常应得到 `https://<机器名>.<tailnet>.ts.net/mcp/...`。

如果最后看到的还是 `http://127.0.0.1:...` 或 exposure 是 `local`，说明公网隧道还没真正建立，不要急着去配置 AI 客户端，先在 Tunnel 卡片里把公网测试跑通。
