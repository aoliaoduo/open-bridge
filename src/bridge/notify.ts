/**
 * Phone notifications via Bark — the outbound "come back to your computer" bell.
 *
 * The operator configures everything in the console (设置 → 手机通知): the device
 * key (the distinctive `https://api.day.app/<key>/…` path segment the Bark app
 * shows — a pasted URL is parsed to the key on save) and two INDEPENDENT
 * switches, either, both, or neither:
 *
 *  - `notify.onTaskDone` (每项任务完成时通知): each todo item that flips to
 *    completed pushes, read from the set_todos diff so it needs no AI
 *    discipline.
 *  - `notify.onFinish` (对话结束时通知): the end-of-exchange push, whether the
 *    AI sends it or the server's watchdog does.
 *
 * These were one either/or `mode` enum (`frequent`/`dnd`) and that was the
 * bug: wanting a bell per finished task AND a bell when the exchange ends is
 * the obvious combination, and an enum made it unexpressible. Two booleans
 * also delete the question "which mode includes what" — each switch names
 * exactly the thing it controls.
 *
 * What is NOT switchable: events meaning a human is needed right now
 * (`attention`, `waiting`). Those always deliver while the channel is usable.
 * An operator who does not want to be interrupted turns the channel off; a
 * question nobody answers stalls the conversation forever, so it is never the
 * thing we silence by default.
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

export const NOTIFY_EVENT_VALUES = ["progress", "attention", "waiting", "finished"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENT_VALUES)[number];

/**
 * Events that always deliver: the conversation cannot continue without the
 * operator. `waiting` is the explicit "I asked a question and am blocked on
 * the answer" — from the server's side an AI awaiting input and an AI that
 * finished look identical (calls simply stop), so the model naming it is the
 * only way to tell the two apart with certainty.
 */
const ALWAYS_EVENTS: ReadonlySet<NotifyEvent> = new Set<NotifyEvent>(["attention", "waiting"]);

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
  /** 每项任务完成时通知 — the set_todos completion bell. */
  onTaskDone: boolean;
  /** 对话结束时通知 — the end-of-exchange bell, AI-sent or watchdog-sent. */
  onFinish: boolean;
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
  const onTaskDone = cfg.get("notify.onTaskDone", CONFIG_DEFAULTS["notify.onTaskDone"]) === true;
  const onFinish = cfg.get("notify.onFinish", CONFIG_DEFAULTS["notify.onFinish"]) === true;
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
  return { usable: enabled && Boolean(key), enabled, onTaskDone, onFinish, key, serverUrl, blocker, idleMinutes };
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
  // `group` defaults to the project name so several bridges on one phone
  // collapse into separate stacks instead of one undifferentiated pile; an
  // explicit group wins.
  const query = new URLSearchParams({ group: extras?.group || "open-bridge" });
  if (extras?.sound) query.set("sound", extras.sound);
  if (extras?.level) query.set("level", extras.level);
  // Bark only reads `volume` for level=critical; sending it otherwise is noise
  // in the URL and in the audit line.
  if (extras?.level === "critical" && extras.volume !== undefined) query.set("volume", String(extras.volume));
  if (extras?.call !== undefined) query.set("call", String(extras.call));
  if (extras?.badge !== undefined) query.set("badge", String(extras.badge));
  if (extras?.url) query.set("url", extras.url);
  if (extras?.icon) query.set("icon", extras.icon);
  if (extras?.isArchive !== undefined) query.set("isArchive", String(extras.isArchive));
  if (extras?.copy) query.set("copy", extras.copy);
  if (extras?.autoCopy !== undefined) query.set("autoCopy", String(extras.autoCopy));
  return `${origin}/${encodeURIComponent(key)}${segments.join("")}?${query.toString()}`;
}

/** The per-call knobs Bark itself supports, as the notify tool exposes them. */
export interface BarkPushExtras {
  /** Ringtone name from the Bark app's sound list (alphanumeric/underscore). */
  sound?: string;
  /**
   * iOS delivery style. `critical` breaks through silent mode and Focus
   * outright, which is why it is the one level the server never picks on the
   * model's behalf without being asked.
   */
  level?: "active" | "timeSensitive" | "passive" | "critical";
  /** Critical-alert volume 0-10. Bark ignores it unless level is critical. */
  volume?: number;
  /** 1 = ring until opened; bounded low — it is a fire alarm, not music. */
  call?: number;
  /** App badge number; 0 clears it. */
  badge?: number;
  /** Where tapping the notification goes (http/https). */
  url?: string;
  /**
   * Notification stack on the phone. Defaults to "open-bridge"; set it per
   * project so two bridges do not interleave into one unreadable pile.
   */
  group?: string;
  /** Icon shown on the notification (iOS 15+). Must be http(s). */
  icon?: string;
  /**
   * 1 = keep the push in Bark's history, 0 = do not. Worth setting explicitly
   * on anything you may want to read after the banner is gone: the default is
   * the app's setting, not ours.
   */
  isArchive?: number;
  /** Text the notification's copy action puts on the clipboard. */
  copy?: string;
  /** 1 = copy without asking. Pair with `copy`, or it copies the body. */
  autoCopy?: number;
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
    if (rawLevel !== "active" && rawLevel !== "timeSensitive" && rawLevel !== "passive" && rawLevel !== "critical") {
      return { ok: false, error: "level must be one of: active, timeSensitive, passive, critical. (expected 'level': string)" };
    }
    extras.level = rawLevel;
  }

  if (args.volume !== undefined && args.volume !== null && args.volume !== "") {
    const volume = typeof args.volume === "number" ? args.volume : Number(args.volume);
    if (!Number.isInteger(volume) || volume < 0 || volume > 10) {
      return { ok: false, error: "volume must be an integer between 0 and 10 (critical alerts only). (expected 'volume': number)" };
    }
    // Say so rather than dropping it: a caller who set volume believed it
    // would be loud, and silently ignoring that is how a "critical" alert
    // turns out to have been a normal one.
    if (extras.level !== "critical") {
      return { ok: false, error: "volume only applies to level \"critical\"; set level to critical or drop volume. (expected 'volume': number)" };
    }
    extras.volume = volume;
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

  const rawGroup = typeof args.group === "string" ? args.group.trim() : "";
  if (rawGroup) {
    if (rawGroup.length > 64) {
      return { ok: false, error: "group must be at most 64 chars — the notification stack this push joins. (expected 'group': string)" };
    }
    extras.group = rawGroup;
  }

  const rawIcon = typeof args.icon === "string" ? args.icon.trim() : "";
  if (rawIcon) {
    if (!/^https?:\/\//i.test(rawIcon) || rawIcon.length > 500) {
      return { ok: false, error: "icon must be an http(s) image link of at most 500 chars (iOS 15+). (expected 'icon': string)" };
    }
    extras.icon = rawIcon;
  }

  if (args.isArchive !== undefined && args.isArchive !== null && args.isArchive !== "") {
    const flag = typeof args.isArchive === "number" ? args.isArchive : Number(args.isArchive);
    if (flag !== 0 && flag !== 1) {
      return { ok: false, error: "isArchive must be 0 or 1 (1 = keep this push in Bark's history). (expected 'isArchive': number)" };
    }
    extras.isArchive = flag;
  }

  const rawCopy = typeof args.copy === "string" ? args.copy.trim() : "";
  if (rawCopy) {
    if (rawCopy.length > 500) {
      return { ok: false, error: "copy must be at most 500 chars — the text the copy action puts on the clipboard. (expected 'copy': string)" };
    }
    extras.copy = rawCopy;
  }

  if (args.autoCopy !== undefined && args.autoCopy !== null && args.autoCopy !== "") {
    const flag = typeof args.autoCopy === "number" ? args.autoCopy : Number(args.autoCopy);
    if (flag !== 0 && flag !== 1) {
      return { ok: false, error: "autoCopy must be 0 or 1 (1 = copy without asking). (expected 'autoCopy': number)" };
    }
    extras.autoCopy = flag;
  }

  return { ok: true, extras };
}

/**
 * The switch gate — one decision point for every push producer.
 *
 * Reads as: interrupts always pass; the two optional bells ask their own
 * switch; anything else (`progress`) is a courtesy that rides along with the
 * task-completion switch, since both mean "routine forward motion".
 */
export function eventSuppressed(
  settings: Pick<NotifySettings, "onTaskDone" | "onFinish">,
  event: NotifyEvent,
): boolean {
  if (ALWAYS_EVENTS.has(event)) return false;
  if (event === "finished") return !settings.onFinish;
  return !settings.onTaskDone;
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
    ({ delivered, event, reason, status, error });

  if (!settings.usable) return logged(outcome(false, settings.blocker || "disabled"), title);
  // "switch_off" rather than the old "mode": the reason names a thing the
  // operator can actually find and flip, instead of a vocabulary they no
  // longer have.
  if (eventSuppressed(settings, event)) return logged(outcome(false, "switch_off"), title);

  const clippedTitle = title.trim().slice(0, BARK_TITLE_LIMIT);
  const clippedBody = body.replace(/\r\n?/g, "\n").trim().slice(0, BARK_BODY_LIMIT);

  // Dedupe the last ATTEMPT, not the last success: a broken channel retried
  // in a loop would page forever if only deliveries consumed the memory.
  const last = ledger.last;
  if (!options.bypassLedger && last
    && event === last.kind && clippedTitle === last.title && clippedBody === last.body
    && nowMs - last.atMs < NOTIFY_DEDUPE_MS) {
    return logged(outcome(false, "duplicate"), clippedTitle);
  }
  ledger.last = { kind: event, title: clippedTitle, body: clippedBody, atMs: nowMs };

  if (!options.bypassLedger) {
    ledger.attempts = ledger.attempts.filter(atMs => nowMs - atMs < NOTIFY_WINDOW_MS);
    if (ledger.attempts.length >= NOTIFY_MAX_PER_WINDOW) {
      return logged(outcome(false, "rate_limited"), clippedTitle);
    }
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
    const probe = await probeHttpHealth(url, { timeoutMs: BARK_TIMEOUT_MS });
    if (probe.ok) {
      // Any push that actually landed disarms the finish watchdog. This is the
      // hinge that makes the fallback mode-aware for free: in frequent mode the
      // completion bell has already rung by the time a list is fully ticked, so
      // the watchdog stays quiet; with that switch off the bell is suppressed,
      // the mark is never set, and the watchdog is the only thing that speaks.
      markSelfNotified(nowMs);
      return logged(outcome(true, "", probe.status), clippedTitle);
    }
    const detail = probe.error || `Bark responded with HTTP ${probe.status}`;
    return logged(outcome(false, "send_failed", probe.status, detail), clippedTitle);
  } catch (error) {
    // probeHttpHealth re-throws only INPUT refusals (bad url/unsafe target);
    // a push whose own URL was refused is a configuration problem worth a line.
    const detail = error instanceof Error ? error.message : String(error);
    return logged(outcome(false, "send_failed", 0, detail), clippedTitle);
  }
}

/**
 * Write the audit line for one push, and hand the outcome straight back so
 * call sites stay one-liners.
 *
 * The status is derived from what actually happened instead of being a
 * hardcoded "progress" — that older line made a delivered `finished` event
 * read as `[notify] progress: push finished`, which is two different senses of
 * the word "progress" (the activity lifecycle vs. the notify event) colliding
 * in one line. It was also written BEFORE the probe, so it announced a push
 * that might then fail, and the UI painted it 「进行中」 forever because nothing
 * ever moved it off that status.
 *
 * A suppressed push is logged too, and that is the point: "my phone did not
 * ring" was previously undebuggable, because every gated path returned in
 * silence. The one exception is a channel that is off or keyless — the
 * operator set that deliberately, and a warning per set_todos would be noise
 * about a decision they already made.
 */
function logged(result: NotifyOutcome, title: string): NotifyOutcome {
  // The url embeds the operator's device key, so only ever a shape is logged
  // here — never the string (the redactor cannot know that path segment is it).
  const label = title ? `: ${title.slice(0, 60)}` : "";
  if (result.delivered) {
    record("notify", "completed", `sent ${result.event}${label}`);
  } else if (result.reason === "send_failed") {
    record("notify", "warning", `send failed (${result.event}): ${result.error}`.slice(0, 500));
  } else if (result.reason !== "disabled" && result.reason !== "no_key") {
    record("notify", "warning", `not sent (${result.reason}): ${result.event}${label}`.slice(0, 500));
  }
  return result;
}

/** Built-in phrasing so a call that only names the event still means something. */
const NOTIFY_PHRASES: Record<NotifyEvent, string> = {
  progress: "进展更新：Open Bridge 完成了一个步骤。",
  attention: "需要你回到电脑前 — Open Bridge 等你确认或选择。",
  waiting: "AI 问了你一个问题，正在等你回答 —— 不回复它就一直卡着。",
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
 * a session that stopped moving (stalled on a question nobody answered,
 * dropped by the browser, rate-limited into silence).
 *
 * It used to require an OPEN todo list, and that requirement quietly disabled
 * it for most of this project's own history. Measured on this workspace's
 * audit log: 2026-09-13 logged 1274 tool calls, 4 of them `set_todos`, and 0
 * notifications — a full day in which no watchdog could have fired, because
 * the AI never wrote a list to have open items on. Tying a safety net to a
 * tool the model is free to forget makes it fail precisely when the model is
 * being forgetful, which is the same failure it exists to cover.
 *
 * So silence alone is now enough. What the todo list still changes is the
 * WORDING: with open items the server can say what stalled, without them it
 * can only report the silence. Both are true statements about observable
 * state; nothing "AI-shaped" is inferred either way. The latch is keyed on
 * `lastUsed`: as soon as any call advances it, the episode is over and a fresh
 * threshold of silence can bell again.
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
  // A session that never called a tool has nothing to have gone quiet from.
  if (input.lastUsedMs <= 0) return false;
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
  // Two different facts, two different sentences. Claiming "work is still in
  // progress" when no list exists would be inventing a state we cannot see.
  const body = activity.hasOpenTodos
    ? `任务还在进行，但 ${minutes} 分钟没有任何动作 — 可能需要你回到电脑前继续。`
    : `连接安静了 ${minutes} 分钟 — AI 可能在等你回复，也可能已经停下。去看一眼。`;
  void pushNotification(
    settings,
    "attention",
    NOTIFY_DEFAULT_TITLE,
    body,
    Date.now(),
    // Time-sensitive on purpose: the whole point of this push is to pierce
    // iOS Focus modes when a web-AI tab died mid-task.
    { bark: { level: "timeSensitive" } },
  ).catch(() => undefined);
  return true;
}

/**
 * Should the server announce an ended conversation the AI never announced?
 *
 * The idle watchdog above deliberately requires an OPEN todo — "silence with
 * work outstanding" is its whole subject. That leaves the opposite case
 * uncovered, and it is the common one: the model ticks the last item, writes
 * its summary in the chat, and simply never calls `notify("finished")`. The
 * operator, who is not watching the tab, learns nothing. Relying on the model
 * to remember is what already failed — repeatedly — so the server states the
 * fact it can see for itself.
 *
 * Crucially this is NOT tied to todos. A conversation that never wrote a list
 * — a question answered, a one-off command, an edit made — ends just as
 * really, and the operator is just as away from the desk. Requiring a
 * completed list to earn a push made the machinery useless for exactly the
 * short exchanges it was wanted for, so a missing list is now a valid ending
 * (held longer, see the settle delay below) rather than a veto.
 *
 * Conditions are deliberately tight, because a wrong "done" is worse than a
 * missing one:
 *  - no list at all, or a list that is entirely completed (never a list with
 *    open items — that silence belongs to the idle watchdog),
 *  - no request currently running (the run is really over, not mid-call),
 *  - a short settle delay after the last call, so the natural
 *    `set_todos` → summary → `notify` ending fires the model's own push first
 *    and this never races it,
 *  - and the AI must not have pushed anything itself since that completion —
 *    `notifiedSinceMs` is how a well-behaved model switches this off.
 *
 * The latch is the completion clock (the last call when there is no list), so
 * there is one announcement per ending: new work advances it and re-arms.
 */
export function finishNoticeVerdict(input: {
  usable: boolean;
  idleMinutes: number;
  nowMs: number;
  lastUsedMs: number;
  activeRequests: number;
  hasTodos: boolean;
  allCompleted: boolean;
  completedAtMs: number;
  notifiedSinceMs: number;
  announcedForMs: number;
}): boolean {
  // idleMinutes === 0 is the operator switching the watchdogs off entirely;
  // this one honours that same switch rather than inventing a second knob.
  if (!input.usable || input.idleMinutes <= 0) return false;
  // An UNFINISHED list is the idle watchdog's territory, not this one's.
  // Staying out of it is what keeps the two from paging for the same silence.
  if (input.hasTodos && !input.allCompleted) return false;
  if (input.activeRequests > 0) return false;
  if (!Number.isFinite(input.completedAtMs) || input.completedAtMs <= 0) return false;
  // The model already said it — that is the outcome we wanted, stay quiet.
  if (input.notifiedSinceMs >= input.completedAtMs) return false;
  // One settle delay for both endings, by explicit operator choice: getting
  // told promptly is the whole point of the channel, and a listless
  // conversation should not have to wait out the idle threshold to be
  // reported. The cost is accepted and real — 45 s of quiet while someone
  // reads a long answer will be announced as an ending, then corrected by the
  // latch as soon as the next call lands.
  const settleMs = Math.min(FINISH_SETTLE_MS, input.idleMinutes * 60_000);
  if (input.nowMs - input.lastUsedMs < settleMs) return false;
  return input.announcedForMs !== input.completedAtMs;
}

/**
 * How long after the last tool call a finished list is considered final.
 *
 * Long enough that a model ending with `set_todos` → a sentence → `notify`
 * wins the race and this stays silent; short enough that an operator who
 * walked away hears within the minute. Capped by idleMinutes above so a very
 * small idle setting cannot be outlived by this delay.
 */
const FINISH_SETTLE_MS = 45_000;

/** Latch: the completion clock we have already announced. */
let finishAnnouncedForMs = 0;

/** Set whenever the AI pushes anything itself; silences the finish watchdog. */
let lastSelfNotifyMs = 0;

/** Called on every successful push so a model's own notify disarms the fallback. */
export function markSelfNotified(atMs: number = Date.now()): void {
  if (atMs > lastSelfNotifyMs) lastSelfNotifyMs = atMs;
}

/**
 * When the current list became fully completed, and whether it is.
 *
 * `completedAtMs` uses the newest session clock rather than a stored
 * timestamp: the moment of completion IS the `set_todos` call that finished
 * it, and that call is the session's `lastUsed`. Reading it here keeps this
 * free of extra bookkeeping in the write path.
 */
function completionSnapshot(): { hasTodos: boolean; allCompleted: boolean; completedAtMs: number } {
  let hasTodos = false;
  let allCompleted = true;
  let completedAtMs = 0;
  let latestActivityMs = 0;
  for (const session of state.sessions.values()) {
    if (session.lastUsed > latestActivityMs) latestActivityMs = session.lastUsed;
    const todos = Array.isArray(session.todos) ? session.todos : [];
    if (todos.length === 0) continue;
    hasTodos = true;
    for (const entry of todos) {
      const todo = asTodo(entry);
      if (todo && todo.status !== "completed") allCompleted = false;
    }
    if (session.lastUsed > completedAtMs) completedAtMs = session.lastUsed;
  }
  // With no list at all there is no completion clock, but the episode still
  // has an end: the last call anyone made. Using it as the latch key gives a
  // listless conversation the same "announce once, re-arm on new work"
  // behaviour a finished list gets — without it, `completedAtMs === 0` would
  // veto every push and a chat that never called set_todos would stay silent,
  // which is the exact coupling this watchdog is meant to break.
  if (!hasTodos) return { hasTodos, allCompleted, completedAtMs: latestActivityMs };
  return { hasTodos, allCompleted, completedAtMs };
}

/**
 * One pass of the finish watchdog, called from the same sweep as
 * `idleNoticeTick` — no new timer, same 60s cadence.
 */
export function finishNoticeTick(nowMs: number = Date.now()): boolean {
  const settings = resolveNotifySettings();
  const activity = latestSessionActivity();
  const completion = completionSnapshot();
  const fire = finishNoticeVerdict({
    ...settings,
    nowMs,
    lastUsedMs: activity.lastUsedMs,
    activeRequests: activity.activeRequests,
    ...completion,
    notifiedSinceMs: lastSelfNotifyMs,
    announcedForMs: finishAnnouncedForMs,
  });
  if (!fire) return false;
  finishAnnouncedForMs = completion.completedAtMs;
  // The two endings read differently to a human glancing at a phone, so say
  // which one happened instead of one vague "done".
  // Deliberately non-committal about WHICH ending this is. From the server's
  // vantage point "the AI answered and stopped" and "the AI asked a question
  // and is waiting" are the same observation: calls stopped arriving. Claiming
  // 「对话已结束」 was wrong half the time, and wrong in the expensive
  // direction — someone who reads "finished" does not hurry back to answer a
  // question that is blocking everything. Both endings want the same action
  // from the human, so the text asks for that action and asserts nothing else.
  const body = completion.hasTodos
    ? "任务清单已全部完成，AI 停下了 —— 可能在等你回复，也可能已经做完。去看一眼。"
    : "AI 停下了 —— 可能在等你回复，也可能这轮已经结束。去看一眼。";
  void pushNotification(settings, "finished", NOTIFY_DEFAULT_TITLE, body, Date.now())
    .catch(() => undefined);
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
  // The non-negotiable half comes first, because it is the one that costs the
  // operator real time when it is skipped: a question asked into an empty room
  // stalls until they happen to look at the screen.
  let text = "\n\n# Phone notifications (Bark)\n"
    + "ALWAYS call notify(event:\"waiting\") immediately after you ask the operator a question or "
    + "present a choice and cannot continue without their answer \u2014 asking and then going quiet "
    + "strands the conversation until they happen to glance at the screen. Call "
    + "notify(event:\"attention\") when you need them back at the keyboard for any other reason. "
    + "These two always deliver; they are not affected by the switches below.";
  if (settings.onTaskDone) {
    text += "\nThe operator turned ON \u300c\u6bcf\u9879\u4efb\u52a1\u5b8c\u6210\u65f6\u901a\u77e5\u300d: every todo item that flips to "
      + "completed in set_todos is pushed automatically, so do not also notify for those. Mark items "
      + "completed as you finish them rather than in one batch at the end \u2014 batching turns a "
      + "progress feed into a single lump and defeats the setting. Use event:\"progress\" only for "
      + "something between items that the list cannot express.";
  } else {
    text += "\nThe operator turned OFF \u300c\u6bcf\u9879\u4efb\u52a1\u5b8c\u6210\u65f6\u901a\u77e5\u300d: completed todos and "
      + "event:\"progress\" are suppressed. Do not work around that gate by relabelling routine "
      + "progress as attention.";
  }
  text += settings.onFinish
    ? "\nThe operator turned ON \u300c\u5bf9\u8bdd\u7ed3\u675f\u65f6\u901a\u77e5\u300d: call notify(event:\"finished\") as the last "
      + "thing you do in an exchange. If you forget, the server sends one itself after a short delay."
    : "\nThe operator turned OFF \u300c\u5bf9\u8bdd\u7ed3\u675f\u65f6\u901a\u77e5\u300d: event:\"finished\" is suppressed.";
  return text;
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
