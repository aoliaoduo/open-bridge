/** Pure TUI value formatters and compact status labels. */
import type { ColorName } from "./theme.js";
import type { TuiSnapshot } from "./render-model.js";

// --- pure formatters (unit-tested; no locale surprises) ---

export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / 1000));
  if (safe < 60) return `${safe}s`;
  if (safe < 3600) return `${Math.floor(safe / 60)}m${String(safe % 60).padStart(2, "0")}s`;
  return `${Math.floor(safe / 3600)}h${String(Math.floor((safe % 3600) / 60)).padStart(2, "0")}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.floor(bytes))}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatCount(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString("en-US");
}

/** Local HH:MM:SS for an ISO instant — the console speaks wall clock (see node-host.ts). */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, "0")).join(":");
}

/**
 * A persisted event from a previous day must not look like it happened today.
 * Keep today's rows compact; add an explicit local date across day/year bounds.
 */
export function formatDatedClock(iso: string, now: number): string {
  const d = new Date(iso);
  const n = new Date(now);
  if (Number.isNaN(d.getTime()) || Number.isNaN(n.getTime())) return "--:--:--";
  const clock = formatClock(iso);
  const sameDay = d.getFullYear() === n.getFullYear()
    && d.getMonth() === n.getMonth()
    && d.getDate() === n.getDate();
  if (sameDay) return clock;
  const mmdd = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hhmm = clock.slice(0, 5);
  return d.getFullYear() === n.getFullYear() ? `${mmdd} ${hhmm}` : `${d.getFullYear()}-${mmdd} ${hhmm}`;
}

export function tunnelTag(snap: TuiSnapshot): { text: string; color: ColorName } {
  if (snap.tunnel === "public") {
    // 提供方名字本身就是「公网」：ngrok/tailscale 不必再挂后缀；状态点与
    // 顶栏的运行中圆点重复，一并去掉 —— 侧栏少一层噪声。
    const provider = snap.tunnelProvider;
    if (provider === "tailscale" || provider === "ngrok") return { text: provider, color: "accent" };
    return { text: "公网", color: "accent" };
  }
  if (snap.tunnel === "follower") {
    const provider = snap.tunnelProvider;
    if (provider === "tailscale") return { text: "跟随 tailscale", color: "review" };
    if (provider === "ngrok") return { text: "跟随 ngrok", color: "review" };
    return { text: "跟随实例", color: "review" };
  }
  if (snap.tunnel === "blocked") {
    return { text: "隧道受阻", color: "error" };
  }
  return { text: "仅本机", color: "dim" };
}

export function exposureTag(snap: TuiSnapshot): { text: string; color: ColorName } {
  if (snap.exposure === "public-open") return { text: "公网 · 未认证", color: "review" };
  if (snap.exposure === "public-authed") return { text: "公网 · Bearer", color: "success" };
  return { text: "仅本机", color: "dim" };
}

export function bar(percent: number, cells: number): string {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
  return `${"▓".repeat(filled)}${"░".repeat(Math.max(0, cells - filled))}`;
}
