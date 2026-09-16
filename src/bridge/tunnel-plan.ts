/**
 * The tunnel card's decisions, as pure functions: what this machine has, what
 * 「自动配置」 would write, and what is left for a human to choose.
 *
 * There is deliberately no I/O in this file. The server detects (it is the only
 * side that can spawn `tailscale status` or read ngrok's config file) and hands
 * the facts to these functions; the console imports the very same functions to
 * show, under the button, what the click is about to write. One rule, two
 * callers — the same reason settings-model.ts owns the settings contract.
 *
 * The second rule these functions encode: a detected value only ever fills a
 * field the operator has NOT filled. Detection is a convenience, never an
 * overwrite — someone who typed a path on purpose must not have it silently
 * replaced by the copy the probe happened to find first.
 */

/** What this machine has for ngrok, read-only. */
export interface NgrokFacts {
  /** A usable ngrok binary was found. */
  installed: boolean;
  /** The copy that would actually run; "" when none was found. */
  executable: string;
  /** Where that copy came from ("PATH", "winget", …) — shown, never guessed. */
  executableLabel: string;
  /**
   * Where an authtoken came from. "stored" is the console's own secret store,
   * "ngrok-config" is the credential ngrok itself keeps in ngrok.yml, "none" is
   * neither. The token VALUE never travels: the import reads it server-side.
   */
  authtokenSource: "stored" | "ngrok-config" | "none";
  /** Reserved domains on the account, best first; [] when unknown. */
  domains: string[];
  /** Why the list above is empty, when the reason is worth showing. */
  domainsError: string | null;
}

/** What this machine has for Tailscale Funnel, read-only. */
export interface TailscaleFacts {
  installed: boolean;
  executable: string;
  executableLabel: string;
  /** `Self.DNSName` exists, i.e. this node is logged in to a tailnet. */
  loggedIn: boolean;
  /** The machine's ts.net name; "" until logged in. */
  domain: string;
  /** `Self.Online` — the node can reach the tailnet right now. */
  online: boolean;
  /** The local port a 443 mount points at, or null when nothing is mounted. */
  mountPort: number | null;
  /** That mount is exposed to the internet (`AllowFunnel`), not tailnet-only. */
  mountPublic: boolean;
}

export interface TunnelFacts {
  ngrok: NgrokFacts;
  tailscale: TailscaleFacts;
}

/** The facts before anything was probed — used by the pre-host fallback state. */
export function emptyTunnelFacts(): TunnelFacts {
  return {
    ngrok: {
      installed: false,
      executable: "",
      executableLabel: "",
      authtokenSource: "none",
      domains: [],
      domainsError: null,
    },
    tailscale: {
      installed: false,
      executable: "",
      executableLabel: "",
      loggedIn: false,
      domain: "",
      online: false,
      mountPort: null,
      mountPublic: false,
    },
  };
}

/**
 * One thing 「自动配置」 decides to write.
 *
 * `kind: "secret"` carries no value on purpose: the authtoken would otherwise
 * have to travel to the browser and back through the page. The executor reads
 * it server-side from `from`, and the console only ever renders the label.
 */
export type AutoConfigWrite =
  | { kind: "config"; key: "ngrokExecutable" | "tailscaleExecutable" | "ngrokDomain"; value: string; label: string }
  | { kind: "secret"; key: "ngrokAuthtoken"; from: "ngrok-config"; label: string };

export interface AutoConfigPlan {
  /** The provider this plan is for; "none" plans nothing. */
  provider: string;
  /**
   * What still stands between the operator and a working public URL, when it is
   * something they must do outside this page (install, log in, enable Funnel).
   * The writes below are still worth applying — the field is a stop for the
   * GOAL, not for the writes.
   */
  blocked: string | null;
  /** Values that will be written (only ever into empty fields). */
  writes: AutoConfigWrite[];
  /** Fields the operator filled themselves; reported so the page can say so. */
  keep: string[];
  /** Read-only observations worth stating next to the button. */
  notes: string[];
}

export interface AutoConfigInput {
  provider: string;
  /** Current config values; "" means unset — the one case a value is written. */
  current: { ngrokExecutable: string; ngrokDomain: string; tailscaleExecutable: string };
  /** True when the console's secret store already holds an authtoken. */
  authtokenStored: boolean;
  facts: TunnelFacts;
}

/** Plan 「自动配置」 for the provider currently selected. */
export function planTunnelAutoConfig(input: AutoConfigInput): AutoConfigPlan {
  if (input.provider === "tailscale") return planTailscale(input);
  if (input.provider === "ngrok") return planNgrok(input);
  return {
    provider: input.provider,
    blocked: "先在上面选一个提供商（ngrok 或 Tailscale Funnel），再点自动配置。",
    writes: [],
    keep: [],
    notes: [],
  };
}

function planNgrok({ current, authtokenStored, facts }: AutoConfigInput): AutoConfigPlan {
  const writes: AutoConfigWrite[] = [];
  const keep: string[] = [];
  const notes: string[] = [];
  const ngrok = facts.ngrok;

  // "ngrok" is the historical alias for "whatever PATH gives us", so it counts
  // as unset: writing the resolved absolute path is the whole point of the
  // pick-list, and leaving the alias behind would keep the tunnel at the mercy
  // of whatever PATH the spawned process happens to inherit.
  const executable = current.ngrokExecutable.trim();
  if (executable && executable !== "ngrok") keep.push(`ngrok 可执行文件（保留你填的 ${executable}）`);
  else if (ngrok.installed && ngrok.executable.trim() && ngrok.executable.trim() !== "ngrok") {
    // Only a path we actually resolved: writing the literal "ngrok" back would
    // be a change in the diff and nothing at all in the tunnel.
    writes.push({
      kind: "config",
      key: "ngrokExecutable",
      value: ngrok.executable,
      label: `ngrok 可执行文件 = ${ngrok.executable}（${ngrok.executableLabel}）`,
    });
  } else if (ngrok.installed) {
    notes.push("找到的 ngrok 只有 PATH 上的名字，没有确定路径：用「高级」里的下拉选一个具体副本。");
  } else {
    notes.push("这台机器上没找到 ngrok：先从 ngrok.com 下载，再用「高级」里的手动填写指出它在哪里。");
  }

  if (ngrok.authtokenSource === "stored" || authtokenStored) {
    keep.push("ngrok authtoken（已保存在凭据库）");
  } else if (ngrok.authtokenSource === "ngrok-config") {
    writes.push({
      kind: "secret",
      key: "ngrokAuthtoken",
      from: "ngrok-config",
      label: "ngrok authtoken（从本机 ngrok 配置导入）",
    });
  } else {
    notes.push("本机没有可导入的 ngrok authtoken：先在终端跑一次 ngrok config add-authtoken，或粘贴到「高级」里。");
  }

  const domain = current.ngrokDomain.trim();
  const first = ngrok.domains[0];
  if (domain) keep.push(`公网地址（保留你填的 ${domain}）`);
  else if (ngrok.domains.length === 1 && first) {
    writes.push({ kind: "config", key: "ngrokDomain", value: first, label: `公网地址 = ${first}` });
  } else if (ngrok.domains.length > 1) {
    // Several reserved domains is a choice, not a missing value: picking one
    // here would be a coin flip that redirects someone else's hostname.
    notes.push(`账号下有 ${ngrok.domains.length} 个保留域名：在「公网地址」下拉里选一个（这里不替你猜）。`);
  } else {
    notes.push(ngrok.domainsError
      ? `读不到你账号下的保留域名：${ngrok.domainsError}`
      : "账号下还没有保留域名：在 ngrok 后台建一个，或留空，用 ngrok 分配的随机地址。");
  }

  const blocked = !ngrok.installed && ngrok.authtokenSource === "none"
    ? "这台机器既没有 ngrok，也没有可导入的 authtoken：先从 ngrok.com 下载 ngrok，并运行一次 ngrok config add-authtoken。"
    : null;
  return { provider: "ngrok", blocked, writes, keep, notes };
}

function planTailscale({ current, facts }: AutoConfigInput): AutoConfigPlan {
  const ts = facts.tailscale;
  if (!ts.installed) {
    return {
      provider: "tailscale",
      blocked: "这台机器上没找到 tailscale：先安装 Tailscale 客户端并登录，再点一次自动配置。",
      writes: [],
      keep: [],
      notes: [],
    };
  }

  const writes: AutoConfigWrite[] = [];
  const keep: string[] = [];
  const notes: string[] = [];

  const executable = current.tailscaleExecutable.trim();
  if (executable) keep.push(`Tailscale 可执行文件（保留你填的 ${executable}）`);
  else {
    writes.push({
      kind: "config",
      key: "tailscaleExecutable",
      value: ts.executable,
      label: `Tailscale 可执行文件 = ${ts.executable}（${ts.executableLabel}）`,
    });
  }

  // The ts.net name is deliberately NOT written by this action: the tunnel's
  // own start path already fills it from the CLI when the setting is empty, and
  // a second writer would just freeze today's name into the config — where the
  // start path then treats it as authoritative and refuses a node that was since
  // renamed.
  if (!ts.loggedIn) {
    notes.push("tailscale 还没登录：先跑一次 tailscale up 或打开客户端登录，域名要登录后才存在。");
  } else {
    notes.push(`公网地址按 tailscale CLI 报告的 ts.net 名自动填写：${ts.domain}（首次开启隧道时写入 tailscaleDomain；换名后启动会报错，把这一项清空即可重新发现）`);
    notes.push(ts.mountPort === null
      ? "443 上还没有挂载：开启隧道时本实例会挂载（免费版只能用 443；若提示 Funnel 未启用，到 login.tailscale.com 打开一次）。"
      : ts.mountPublic
        ? `443 上已挂载到本机端口 ${ts.mountPort}，Funnel 对公网开放。`
        : `443 上挂的是 tailnet 内的 serve（只有你自己的设备能访问，公网不通）→ 本机端口 ${ts.mountPort}。`);
    if (!ts.online) notes.push("这个节点当前显示离线：Tailscale 客户端没在运行，隧道起不来。");
  }

  const blocked = !ts.loggedIn
    ? "tailscale CLI 在，但这个节点还没登录：先 tailscale up，再回来点一次自动配置。"
    : null;
  return { provider: "tailscale", blocked, writes, keep, notes };
}
