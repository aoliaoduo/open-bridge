/**
 * Phone notifications via Bark — the outbound "come back to your computer" bell.
 *
 * The operator configures everything in the console (设置 → 手机通知): the device
 * key (the distinctive `https://api.day.app/<key>/…` path segment the Bark app
 * shows — a pasted URL is parsed to the key on save) and the mode:
 *
 *  - `frequent` (频繁): push a message for each todo item that flips to
 *    completed (the set_todos diff, so it needs no AI discipline), and every
 *    plain notify call delivers.
 *  - `dnd` (免打扰): only events that genuinely mean "a human is needed" get
 *    through — attention (需要选择/回话) and finished (对话结束). Softer events
 *    return delivered:false with the reason instead of failing: the AI learns
 *    the gate and adapts rather than seeing errors.
 *
 * Deliberately absent: a provider registry (Bark today; when a second provider
 * arrives, its keys get their own namespaced config), per-event sound/level
 * catalogs, and any way for an MCP `notify` call to name a recipient — the
 * destination is operator-controlled or nothing.
 *
 * The wire path is `probeHttpHealth`, not raw fetch: it resolves first, pins
 * the vetted IP (an operator who stored a hostname is not re-resolvable into
 * an internal address after the fact), refuses redirects by default, and the
 * probe reads headers only — a push is a one-way door, exactly like the
 * service-health probes that established this path.
 */

import { probeHttpHealth } from "../network/safe-probe.js";
import { host } from "../host/host.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { canonicalBarkOrigin, parseBarkKeyInput } from "./config-values.js";
import { record, state } from "./state.js";
import type { JsonArgs } from "./json-args.js";

export const NOTIFY_EVENT_VALUES = ["progress", "attention", "finished"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENT_VALUES)[number];
export type NotifyMode = "frequent" | "dnd";

/** Events whose whole meaning is "a human is needed" — they pass every mode. */
const ATTENTION_EVENTS: ReadonlySet<NotifyEvent> = new Set<NotifyEvent>(["attention", "finished"]);

/** bark GET needs no response body; 8 s is patient for a push over the world. */
const BARK_TIMEOUT_MS = 8_000;

/** Same cap the audit entries use: title and body are sentences, not files. */
const BARK_BODY_LIMIT = 500;
const BARK_TITLE_LIMIT = 120;
export const NOTIFY_DEFAULT_TITLE = "Open Bridge";

const BARK_DEFAULT_URL = CONFIG_DEFAULTS["notify.serverUrl"] as string;

/**
 * Sliding-window budget for wire ATTEMPTS: 6 per 60 s. Honest pacing (todo
 * completions seconds apart, a finished event, an occasional attention) never
 * reaches it; a runaway loop paging the operator's phone does, and that is
 * what it exists to bound. Shared by every producer on purpose — the phone
 * cannot tell which subsystem is ringing.
 */
export const NOTIFY_MAX_PER_WINDOW = 6;
export const NOTIFY_WINDOW_MS = 60_000;
/** An identical repeat of the last attempt inside this window is not pushed. */
export const NOTIFY_DEDUPE_MS = 60_000;

/** Settings after every fallible cleanup, ready to use or refuse. */
export interface NotifySettings {
  /** Master switch AND a usable key: no push happens when either is missing. */
  usable: boolean;
  enabled: boolean;
  mode: NotifyMode;
  /** Already parsed; "" when nothing/invalid is stored. Never echo it back. */
  key: string;
  /** Canonical origin, defaulting to the official api.day.app host. */
  serverUrl: string;
  /** Why the channel is not ready ("disabled" / "no_key" / ""), for messages. */
  blocker: string;
  /** Minutes of total MCP silence with unfinished todos before the watchdog bells; 0 = off. */
  idleMinutes: number;
}

export interface NotifyOutcome {
  delivered: boolean;
  event: NotifyEvent;
  mode: NotifyMode;
  /** The stable verb for suppression bookkeeping; "" when it went out. */
  reason: string;
  /** Bark's HTTP status when it answered; 0 when nothing was sent. */
  status: number;
  /** Human-readable failure detail; "" when there was none. */
  error: string;
}

export function resolveNotifySettings(): NotifySettings {
  const cfg = host().config;
  const enabled = cfg.get("notify.enabled", CONFIG_DEFAULTS["notify.enabled"]) === true;
  const rawMode = cfg.get("notify.mode", CONFIG_DEFAULTS["notify.mode"]);
  const mode: NotifyMode = rawMode === "dnd" ? "dnd" : "frequent";
  // A hand-edited config.json is untrusted input like every other read:
  // re-parse on the read side so the send path never trusts bytes on disk.
  const rawKey = cfg.get("notify.barkKey", CONFIG_DEFAULTS["notify.barkKey"]);
  const key = typeof rawKey === "string" ? (parseBarkKeyInput(rawKey) ?? "") : "";
  let serverUrl = BARK_DEFAULT_URL;
  try {
    serverUrl = canonicalBarkOrigin(String(cfg.get("notify.serverUrl", BARK_DEFAULT_URL) || BARK_DEFAULT_URL));
  } catch {
    // An unusable hand-edited origin falls back to the official host rather
    // than pointing the bell at whatever the malformed string happens to name.
  }
  const blocker = !enabled ? "disabled" : key ? "" : "no_key";
  const idleMinutes = clampIdleMinutes(cfg.get<unknown>("notify.idleMinutes", CONFIG_DEFAULTS["notify.idleMinutes"]));
  return { usable: enabled && Boolean(key), enabled, mode, key, serverUrl, blocker, idleMinutes };
}

const DEFAULT_IDLE_MINUTES = CONFIG_DEFAULTS["notify.idleMinutes"] as number;

/**
 * No Math.max floor-trick on the raw value: a NaN from a hand-edited config
 * must land on the default, not on `idleMs < NaN` — which is false forever,
 * and a watchdog that silently never fires is the exact silent failure this
 * repo's guard rules refuse. 0 keeps its meaning (off); nothing else does.
 */
export function clampIdleMinutes(value: unknown): number {
  const numeric = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return DEFAULT_IDLE_MINUTES;
  return Math.min(1440, Math.floor(numeric));
}

/**
 * Bark GET url: `origin/<key>/<title>/<body>?group=…`, title and body
 * percent-encoded (the same shape as every Bark client and the public docs).
 * `extras` appends the operator-visible knobs the AI chose (sound/level/call/
 * badge/url) as query parameters in a fixed order; absent fields are omitted,
 * so the plain push URL shape is unchanged.
 */
export function buildBarkUrl(serverUrl: string, key: string, title: string, body: string, extras?: BarkPushExtras): string {
  const origin = serverUrl.replace(/\/+$/u, "");
  const segments = [title, body].filter(part => part.length > 0).map(part => `/${encodeURIComponent(part)}`);
  const query = new URLSearchParams({ group: "open-bridge" });
  if (extras?.sound) query.set("sound", extras.sound);
  if (extras?.level) query.set("level", extras.level);
  if (extras?.call !== undefined) query.set("call", String(extras.call));
  if (extras?.badge !== undefined) query.set("badge", String(extras.badge));
  if (extras?.url) query.set("url", extras.url);
  return `${origin}/${encodeURIComponent(key)}${segments.join("")}?${query.toString()}`;
}

/** The per-call knobs Bark itself supports, as the notify tool exposes them. */
export interface BarkPushExtras {
  /** Ringtone name from the Bark app's sound list (alphanumeric/underscore). */
  sound?: string;
  /** iOS delivery style: active (default) | timeSensitive (pierces Focus) | passive (silent list entry). */
  level?: "active" | "timeSensitive" | "passive";
  /** 1 = ring until opened; bounded low — it is a fire alarm, not music. */
  call?: number;
  /** App badge number; 0 clears it. */
  badge?: number;
  /** Where tapping the notification goes (http/https). */
  url?: string;
}

/**
 * Validate the model's optional Bark knobs BEFORE anything leaves. Returns a
 * refusal that names the parameter and the expectation (the tool-guard rule:
 * the caller must be able to fix the call from the error alone), or the clean
 * extras object. Absent and empty mean "not provided" and stay absent.
 */
export function parseBarkExtras(args: JsonArgs): { ok: true; extras: BarkPushExtras } | { ok: false; error: string } {
  const extras: BarkPushExtras = {};

  const rawSound = typeof args.sound === "string" ? args.sound.trim() : "";
  if (rawSound) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(rawSound)) {
      return { ok: false, error: "sound must be a ringtone name from the Bark app (letters, digits, _; max 64 chars). (expected 'sound': string)" };
    }
    extras.sound = rawSound;
  }

  const rawLevel = typeof args.level === "string" ? args.level.trim() : "";
  if (rawLevel) {
    if (rawLevel !== "active" && rawLevel !== "timeSensitive" && rawLevel !== "passive") {
      return { ok: false, error: "level must be one of: active, timeSensitive, passive. (expected 'level': string)" };
    }
    extras.level = rawLevel;
  }

  if (args.call !== undefined && args.call !== null && args.call !== "") {
    const call = typeof args.call === "number" ? args.call : Number(args.call);
    if (!Number.isInteger(call) || call < 1 || call > 10) {
      return { ok: false, error: "call must be an integer between 1 and 10 (1 = ring until opened). (expected 'call': number)" };
    }
    extras.call = call;
  }

  if (args.badge !== undefined && args.badge !== null && args.badge !== "") {
    const badge = typeof args.badge === "number" ? args.badge : Number(args.badge);
    if (!Number.isInteger(badge) || badge < 0 || badge > 9999) {
      return { ok: false, error: "badge must be an integer between 0 and 9999. (expected 'badge': number)" };
    }
    extras.badge = badge;
  }

  const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
  if (rawUrl) {
    if (!/^https?:\/\//i.test(rawUrl) || rawUrl.length > 500) {
      return { ok: false, error: "url must be an http(s) link of at most 500 chars — where tapping the notification goes. (expected 'url': string)" };
    }
    extras.url = rawUrl;
  }

  return { ok: true, extras };
}

/** The mode gate — one decision point for every push producer. */
export function modeSuppresses(mode: NotifyMode, event: NotifyEvent): boolean {
  return mode === "dnd" && !ATTENTION_EVENTS.has(event);
}

/** The shared ledger of recent attempts; exported view only, treat as opaque. */
interface NotifyLedger {
  attempts: number[];
  last: { kind: string; title: string; body: string; atMs: number } | undefined;
}

const ledger: NotifyLedger = { attempts: [], last: undefined };

/**
 * Send one push if the mode (and the budget) allows it. Never rejects: a bell
 * must not break the thing it reports on. An outcome is returned for every
 * path so the MCP tool can echo it and the audit can stay informative.
 *
 * `bypassLedger` is for a human action on the loopback console ("发送测试"):
 * the budget exists to bound AGENTS paging the phone, and an operator
 * re-pressing a test because they did not hear the first one is precisely
 * the case dedupe would wrongly silence. The mode and the switch still gate.
 */
export async function pushNotification(
  settings: NotifySettings,
  event: NotifyEvent,
  title: string,
  body: string,
  nowMs: number = Date.now(),
  options: { bypassLedger?: boolean; bark?: BarkPushExtras } = {},
): Promise<NotifyOutcome> {
  const outcome = (delivered: boolean, reason: string, status = 0, error = ""): NotifyOutcome =>
    ({ delivered, event, mode: settings.mode, reason, status, error });

  if (!settings.usable) return outcome(false, settings.blocker || "disabled");
  if (modeSuppresses(settings.mode, event)) return outcome(false, "mode");

  const clippedTitle = title.trim().slice(0, BARK_TITLE_LIMIT);
  const clippedBody = body.replace(/\r\n?/g, "\n").trim().slice(0, BARK_BODY_LIMIT);

  // Dedupe the last ATTEMPT, not the last success: a broken channel retried
  // in a loop would page forever if only deliveries consumed the memory.
  const last = ledger.last;
  if (!options.bypassLedger && last
    && event === last.kind && clippedTitle === last.title && clippedBody === last.body
    && nowMs - last.atMs < NOTIFY_DEDUPE_MS) {
    return outcome(false, "duplicate");
  }
  ledger.last = { kind: event, title: clippedTitle, body: clippedBody, atMs: nowMs };

  if (!options.bypassLedger) {
    ledger.attempts = ledger.attempts.filter(atMs => nowMs - atMs < NOTIFY_WINDOW_MS);
    if (ledger.attempts.length >= NOTIFY_MAX_PER_WINDOW) return outcome(false, "rate_limited");
    ledger.attempts.push(nowMs);
  } else {
    // A manual press never gates itself — the operator re-pressing because
    // they heard nothing must get another bell. It still leaves a mark on
    // the shared window (a human hammering would page the phone too), it
    // simply does not consult one.
    ledger.attempts = [...ledger.attempts.filter(atMs => nowMs - atMs < NOTIFY_WINDOW_MS), nowMs];
  }

  const url = buildBarkUrl(settings.serverUrl, settings.key, clippedTitle, clippedBody, options.bark);
  try {
    // The url embeds the operator's device key: log a shape, never the string
    // (and the redactor has no way to know this particular path segment is it).
    record("notify", "progress", `push ${event}: ${clippedTitle.slice(0, 60)}`);
    const probe = await probeHttpHealth(url, { timeoutMs: BARK_TIMEOUT_MS });
    if (probe.ok) return outcome(true, "", probe.status);
    const detail = probe.error || `Bark responded with HTTP ${probe.status}`;
    record("notify", "warning", `push failed (${event}): ${detail}`.slice(0, 500));
    return outcome(false, "send_failed", probe.status, detail);
  } catch (error) {
    // probeHttpHealth re-throws only INPUT refusals (bad url/unsafe target);
    // a push whose own URL was refused is a configuration problem worth a line.
    const detail = error instanceof Error ? error.message : String(error);
    record("notify", "warning", `push refused (${event}): ${detail}`.slice(0, 500));
    return outcome(false, "send_failed", 0, detail);
  }
}

/** Built-in phrasing so a call that only names the event still means something. */
const NOTIFY_PHRASES: Record<NotifyEvent, string> = {
  progress: "进展更新：Open Bridge 完成了一个步骤。",
  attention: "需要你回到电脑前 — Open Bridge 等你确认或选择。",
  finished: "Open Bridge 的任务对话已结束，可以回来看看结果。",
};
/**
 * The MCP tool: `notify(event, title?, message?)`. A missing message falls
 * back to the built-in phrase for the event; the model's own text always
 * wins when present. Suppression is a structured `delivered:false`, not an
 * error — the caller learns the gate instead of seeing failures. An
 * explicit "" message is likewise treated as absence, because an empty push
 * says nothing on any phone.
 */
export async function notifyTool(args: JsonArgs): Promise<NotifyOutcome> {
  const rawEvent = typeof args.event === "string" ? args.event.trim() : "";
  if (!rawEvent) {
    throw new Error(`Missing "event": pass one of: ${NOTIFY_EVENT_VALUES.join(", ")}. (expected 'event': string)`);
  }
  if (!(NOTIFY_EVENT_VALUES as readonly string[]).includes(rawEvent)) {
    throw new Error(`Unknown event "${rawEvent}". Pass one of: ${NOTIFY_EVENT_VALUES.join(", ")}.`);
  }
  // Optional Bark knobs are validated before any settings read: a bad value is
  // the model's to fix, and the error must name the parameter to fix.
  const extras = parseBarkExtras(args);
  if (!extras.ok) throw new Error(extras.error);
  const event = rawEvent as NotifyEvent;
  const rawTitle = typeof args.title === "string" ? args.title.trim() : "";
  const rawMessage = typeof args.message === "string" ? args.message.trim() : "";
  const title = rawTitle || NOTIFY_DEFAULT_TITLE;
  const body = rawMessage || NOTIFY_PHRASES[event];
  // `record` for the tool call itself happens in the dispatcher's invoke();
  // this just answers with the structured outcome the schema promises.
  return await pushNotification(resolveNotifySettings(), event, title, body, Date.now(), { bark: extras.extras });
}

/** A completed item, as a previous list can express it. */
interface TodoLike {
  id?: unknown;
  title?: unknown;
  status?: unknown;
}

/** Object entries only: a persisted list is data from disk, not a promise. */
function asTodo(value: unknown): TodoLike | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as TodoLike
    : undefined;
}

/**
 * Items newly finished by this set_todos call: completed now, and either
 * never seen (id not in the previous list) or in a non-completed state
 * before. Removed-and-re-added items count as new completions on purpose —
 * a list the AI rebuilds every round must not silently stop ringing.
 */
export function newlyCompletedTodos(previous: readonly unknown[], next: readonly unknown[]): TodoLike[] {
  const before = new Map<string, string>();
  for (const raw of previous) {
    const item = asTodo(raw);
    if (!item) continue;
    const id = typeof item.id === "string" ? item.id : "";
    const title = typeof item.title === "string" ? item.title : "";
    const key = id || title;
    if (key && typeof item.status === "string") before.set(key, item.status);
  }
  const done: TodoLike[] = [];
  for (const raw of next) {
    const item = asTodo(raw);
    if (!item || item.status !== "completed") continue;
    const id = typeof item.id === "string" ? item.id : "";
    const title = typeof item.title === "string" ? item.title : "";
    const key = id || title;
    if (!key || before.get(key) === "completed") continue;
    done.push(item);
  }
  return done;
}

/**
 * The frequent-mode hook: one push per set_todos call, naming the items
 * (a batch completion pages as one message — 2 s apart, 30 completed items
 * become 30 pages, not 2). Best-effort by design — the bell observes the
 * work list, it never gates it. Mode is checked inside pushNotification,
 * so 免打扰 suppresses here without a duplicated rule.
 */
export function pushTodoCompletions(previous: readonly unknown[], next: readonly unknown[]): void {
  const settings = resolveNotifySettings();
  if (!settings.usable) return;
  const done = newlyCompletedTodos(previous, next);
  if (done.length === 0) return;
  const titles = done.slice(0, 10)
    .map(item => (typeof item.title === "string" && item.title.trim() ? item.title.trim() : "未命名任务"));
  const body = `${titles.join("、")}${done.length > 10 ? ` 等 ${done.length} 项` : ""}。`;
  void pushNotification(settings, "progress", NOTIFY_DEFAULT_TITLE, body).catch(() => undefined);
}

/**
 * The idle watchdog — notifications on the one thing MCP calls cannot report:
 * a web-AI session that stopped moving while work is still open (stalled on a
 * question nobody answered, dropped by the browser, rate-limited into
 * silence). Every input comes from observable state; nothing "AI-shaped" is
 * inferred. The latch is keyed on `lastUsed`: as soon as any call advances it,
 * the episode is over and a fresh threshold of silence can bell again.
 */
export function idleWatchVerdict(input: {
  usable: boolean;
  idleMinutes: number;
  nowMs: number;
  lastUsedMs: number;
  activeRequests: number;
  hasOpenTodos: boolean;
  notifiedForMs: number;
}): boolean {
  if (!input.usable || input.idleMinutes <= 0) return false;
  // A request still in flight is the Bridge being slow, not the human being
  // away — do not page anyone over our own processing.
  if (input.activeRequests > 0) return false;
  // "No tool calls for N minutes" is also the normal shape of a conversation
  // that ended healthy. A push is warranted only with an OPEN work list:
  // someone planned work and it stopped moving.
  if (!input.hasOpenTodos) return false;
  const idleMs = input.nowMs - input.lastUsedMs;
  if (!Number.isFinite(idleMs) || idleMs < input.idleMinutes * 60_000) return false;
  return input.notifiedForMs !== input.lastUsedMs;
}

/** One summary across all live sessions: the clock the watchdog reads. */
function latestSessionActivity(): { lastUsedMs: number; activeRequests: number; hasOpenTodos: boolean } {
  let lastUsedMs = 0;
  let activeRequests = 0;
  let hasOpenTodos = false;
  for (const session of state.sessions.values()) {
    if (session.lastUsed > lastUsedMs) lastUsedMs = session.lastUsed;
    activeRequests += session.activeRequests || 0;
    if (session.todos.some(todo => todo && typeof todo === "object" && (todo as TodoLike).status !== "completed")) {
      hasOpenTodos = true;
    }
  }
  return { lastUsedMs, activeRequests, hasOpenTodos };
}

/** The idle latch: last `lastUsed` clock we already pushed a silence notice for. */
let idleNotifiedForMs = 0;

/**
 * One pass of the idle watchdog, called from the session-prune sweep. The
 * verdict is the pure `idleWatchVerdict`; this wires state + push + latch.
 * Latching on `lastUsed` means one push per silence episode: any later call
 * advances the clock, and a fresh threshold of silence can bell again.
 */
export function idleNoticeTick(nowMs: number = Date.now()): boolean {
  const settings = resolveNotifySettings();
  const activity = latestSessionActivity();
  const fire = idleWatchVerdict({ ...settings, ...activity, nowMs, notifiedForMs: idleNotifiedForMs });
  if (!fire) return false;
  idleNotifiedForMs = activity.lastUsedMs;
  const minutes = settings.idleMinutes;
  void pushNotification(
    settings,
    "attention",
    NOTIFY_DEFAULT_TITLE,
    `任务还在进行，但 ${minutes} 分钟没有任何动作 — 可能需要你回到电脑前继续。`,
    Date.now(),
    // Time-sensitive on purpose: the whole point of this push is to pierce
    // iOS Focus modes when a web-AI tab died mid-task.
    { bark: { level: "timeSensitive" } },
  ).catch(() => undefined);
  return true;
}

/**
 * What a connect-time AI is told about notifications. Pure; a real
 * suffix only appears while the channel is actually usable (so a connect
 * never carries a lecture about machinery it cannot reach), and the text
 * changes with the mode so the model knows what the machine will accept.
 */
export function notifyUsageInstructions(settings: NotifySettings): string {
  if (!settings.usable) return "";
  if (settings.mode === "dnd") {
    return "\n\n# Phone notifications (Bark, dnd mode)\n"
      + "The operator wants to be paged ONLY when a human is actually needed: call "
      + "notify(event:\"attention\") when you need their choice, approval or return to the keyboard, "
      + "and notify(event:\"finished\") when the exchange ends and they can check the result. "
      + "Everything softer (event:\"progress\") is suppressed in this mode \u2014 do not reach for it "
      + "to report routine steps or to work around the gate. set_todos/completion progress also "
      + "stays silent here; that is the point.";
  }
  return "\n\n# Phone notifications (Bark, frequent mode)\n"
    + "The operator opted into push updates: every todo item that flips to completed in set_todos "
    + "is delivered automatically, so do not also notify for those. Use notify for what the list "
    + "cannot say: event:\"progress\" with one line about something between items, "
    + "event:\"attention\" when a human is needed now, and event:\"finished\" when the exchange ends.";
}

/**
 * Wipe the ledger of recent attempts + the idle latch. Called from lifecycle
 * stop: these are process-lifetime facts — a restart starts with a clean rate
 * budget and never inherits an old silence episode.
 */
export function clearNotifyLedger(): void {
  ledger.attempts = [];
  ledger.last = undefined;
  idleNotifiedForMs = 0;
}
