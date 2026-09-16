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
import { playAlertSound, soundFileForEvent } from "./sound-alert.js";
import { anyChannelSpeaks, routeEvent, type ChannelState } from "./notify-routing.js";
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
  /**
   * Can the operator be reached AT ALL — by phone or by a sound on this
   * machine. The watchdogs gate on this; gating them on Bark alone meant
   * switching the phone off also silenced the desktop.
   */
  usable: boolean;
  /** Bark specifically: the master switch AND a usable device key. */
  barkUsable: boolean;
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
  /** Minutes of total MCP silence before the watchdog bells; 0 = off. Todos are not required. */
  idleMinutes: number;
}

export interface NotifyOutcome {
  /**
   * Did the PHONE push go out. Named for history; `announced` is the honest
   * answer to "was the operator told".
   */
  delivered: boolean;
  event: NotifyEvent;
  /** The stable verb for suppression bookkeeping; "" when it went out. */
  reason: string;
  /** Bark's HTTP status when it answered; 0 when nothing was sent. */
  status: number;
  /** Human-readable failure detail; "" when there was none. */
  error: string;
  /**
   * Did a sound play on the bridge machine.
   *
   * Added because the result was lying by omission: with the phone switched
   * off and a sound configured, a notify call played audio and still returned
   * `delivered:false, reason:"disabled"`. A model reading that concludes it
   * failed to reach anyone and may well say so to the operator who just heard
   * the chime.
   */
  sounded: boolean;
  /**
   * Did ANY channel reach the operator. This is the field a caller should
   * branch on; `delivered` answers a narrower question than its name suggests.
   */
  announced: boolean;
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
  const barkUsable = enabled && Boolean(key);
  // `usable` means "some channel can reach the operator", not "Bark can".
  //
  // The local sound was deliberately placed ahead of every Bark gate so a
  // machine with no Bark key still chimes — but the watchdogs never got that
  // far: finishNoticeVerdict and idleNoticeVerdict both open with
  // `if (!input.usable) return false`, so turning the phone channel off
  // silenced the desktop one too. Reported as "I waited and the computer
  // never made a sound", with sound.enabled true and both files configured.
  //
  // Splitting the two keeps each gate asking its own question: Bark's send
  // path checks barkUsable, the watchdogs check whether anything at all can
  // be said.
  const soundUsable = cfg.get<boolean>("sound.enabled", false) === true
    && Boolean(String(cfg.get<string>("sound.fileWaiting", "") ?? "").trim()
      || String(cfg.get<string>("sound.fileFinished", "") ?? "").trim());
  return {
    usable: barkUsable || soundUsable,
    barkUsable,
    enabled,
    onTaskDone,
    onFinish,
    key,
    serverUrl,
    blocker,
    idleMinutes,
  };
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
 * `extras` appends presentation parameters in a fixed order; absent fields
 * are omitted, so the plain push URL shape is unchanged. These come from the
 * operator's per-event settings (or, for the server's own pushes, from the
 * call site) -- never from a tool call.
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

/**
 * The presentation parameters Bark supports. Filled from the operator's
 * settings for the event, plus the handful the server sets for its own pushes.
 * Not reachable from a tool call: see withEventDefaults.
 */
export interface BarkPushExtras {
  /** Ringtone name from the Bark app's sound list (alphanumeric/underscore). */
  sound?: string;
  /**
   * iOS delivery style. `critical` breaks through silent mode and Focus
   * outright -- which is exactly why choosing it is the operator's call, made
   * once in settings, and not a judgement made per-push by a caller who cannot
   * see what they chose.
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
 * The switch gate — one decision point for every push producer.
 *
 * Reads as: interrupts always pass; the two optional bells ask their own
 * switch; anything else (`progress`) is a courtesy that rides along with the
 * task-completion switch, since both mean "routine forward motion".
 */
/**
 * Snapshot the routing inputs for one event.
 *
 * `soundReady` is per-event because a file configured for "waiting" says
 * nothing about "finished" — the two slots are independent, and collapsing
 * them is how a channel ends up claiming it can speak when it cannot.
 */
export function channelStateFor(event: NotifyEvent, settings: NotifySettings): ChannelState {
  return {
    barkReady: settings.barkUsable,
    soundReady: Boolean(soundFileForEvent(event)),
    onTaskDone: settings.onTaskDone,
    onFinish: settings.onFinish,
  };
}

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
/** The config-key infix of one event: `notify.call<Infix>`, `notify.level<Infix>`. */
function eventSuffix(event: NotifyEvent): "Attention" | "Waiting" | "Finished" | "Progress" {
  return event === "attention" ? "Attention"
    : event === "waiting" ? "Waiting"
      : event === "finished" ? "Finished"
        : "Progress";
}

/**
 * Is 「持续响铃」 on for this event? Read once per push and again on every
 * repeat tick, so turning the switch off stops a ringing phone without a
 * restart.
 */
function callEnabledFor(event: NotifyEvent): boolean {
  return host().config.get<boolean>(`notify.call${eventSuffix(event)}`, false) === true;
}

/**
 * Fill in the operator's per-event preferences where the caller said nothing.
 *
 * Reads config directly rather than going through NotifySettings: these are
 * presentation choices consulted once per push, and threading eleven more
 * fields through the settings struct would make every caller carry knobs it
 * has no opinion about.
 */
export function withEventDefaults(
  event: NotifyEvent,
  bark?: BarkPushExtras,
  options: { trusted?: boolean } = {},
): BarkPushExtras | undefined {
  const cfg = host().config;
  const suffix = eventSuffix(event);
  const level = String(cfg.get<string>(`notify.level${suffix}`, "") ?? "").trim();
  // Every event can ring. Offering it on only two was a judgement about which
  // events "deserve" it, and the page had no room to explain the distinction —
  // so it read as a bug. Someone who wants their phone to ring until they
  // acknowledge a finished run is not making a mistake.
  const call = cfg.get<boolean>(`notify.call${suffix}`, false) === true;

  // How loud a notification is belongs to the operator, who said so once on
  // the settings page. This used to merge the other way round — config filled
  // only what the caller left blank — so anything a caller DID say won, and a
  // model answering `level: "critical"` pierced a silent mode the operator had
  // chosen, or `call: 1` started a ring they never enabled. The model cannot
  // read those settings, so it was overruling a preference it could not see.
  //
  // `trusted` is for the server's own pushes (the idle watchdog, the settings
  // page's test button), which are deliberate local decisions rather than a
  // guess made elsewhere — and are the reason this parameter still exists.
  const merged: BarkPushExtras = options.trusted === true ? { ...(bark ?? {}) } : {};
  if (merged.level === undefined && isNotifyLevel(level)) merged.level = level;
  if (merged.call === undefined && call) merged.call = 1;
  return Object.keys(merged).length ? merged : undefined;
}

/**
 * The arguments the notify tool accepts, and the whole of what a model may
 * decide: what happened, and what to say about it.
 *
 * Exported so the tool definition and its contract test read the same list —
 * a knob re-added to the schema without appearing here is a test failure, not
 * a silent return of the override.
 */
export function notifyToolArgKeys(): readonly string[] {
  return ["event", "title", "message"];
}

/** Stated once, so the rest of the system can be read against it. */
export const presentationIsOperatorOwned = true;

function isNotifyLevel(value: string): value is NonNullable<BarkPushExtras["level"]> {
  return value === "active" || value === "timeSensitive" || value === "passive" || value === "critical";
}

export async function pushNotification(
  settings: NotifySettings,
  event: NotifyEvent,
  title: string,
  body: string,
  nowMs: number = Date.now(),
  options: { bypassLedger?: boolean; silentLocally?: boolean; bark?: BarkPushExtras; repeat?: boolean } = {},
): Promise<NotifyOutcome> {
  // Declared before `outcome` so every return path reports the sound too --
  // the previous shape let a chime happen and still answer "delivered:false,
  // reason:disabled", which reads as "nobody was told".
  let sounded = false;
  const outcome = (delivered: boolean, reason: string, status = 0, error = ""): NotifyOutcome =>
    ({ delivered, event, reason, status, error, sounded, announced: delivered || sounded });

  // Both channels are decided in one place, by the table, instead of by a
  // chain of ifs whose order encoded policy. The ordering still matters --
  // the sound plays before the phone is even considered, so a machine with no
  // Bark key still chimes -- but "may this channel speak" is now a question
  // asked of notify-routing.ts rather than answered inline.
  const route = routeEvent(event, channelStateFor(event, settings));

  // `silentLocally` is a caller saying "this push is about ONE channel". The
  // Bark test button needs it: the test travels as an `attention` event, and
  // without this pressing 发送测试 under 手机（Bark） also played music.
  if (route.sound === true && !options.silentLocally) {
    const soundFile = soundFileForEvent(event);
    if (soundFile) sounded = playAlertSound(soundFile).played;
  }

  if (route.bark !== true) {
    // The table's reason is more specific than the old settings.blocker, but
    // blocker still wins when it has something to say: it distinguishes
    // "disabled" from "no_key", which the router deliberately does not model.
    const reason = route.bark === "switch_off" ? "switch_off" : (settings.blocker || route.bark);
    return logged(outcome(false, reason), title);
  }
  // The switch check used to live here as a second gate. It is the table's
  // job now — keeping both would be two copies of one rule, which is exactly
  // how the rules drifted apart the first time.

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

  // Per-event presentation from the console. The AI knows what happened; the
  // operator knows how they want to be told about it, and only one of those
  // two is sitting next to the phone. `options.bark` reaches this function
  // only from inside the server (the idle watchdog, the settings-page test
  // button) -- it is no longer anything a tool call can set, so honouring it
  // here is honouring a local decision, not a remote guess.
  const url = buildBarkUrl(
    settings.serverUrl,
    settings.key,
    clippedTitle,
    clippedBody,
    withEventDefaults(event, options.bark, { trusted: true }),
  );
  try {
    const probe = await probeHttpHealth(url, { timeoutMs: BARK_TIMEOUT_MS });
    if (probe.ok) {
      // Only a push that SAID something about the ending disarms the finish
      // watchdog — see announcesEnding. That is the hinge which makes the
      // fallback respect the switches for free: a model that announces its own
      // ending is not second-guessed. It used to be EVERY delivered push, and
      // that is where the ending bell went: todo-completion pushes are
      // frequent, they land seconds before the exchange ends, and a message
      // about one ticked box answered for an ending it never mentioned.
      markSelfNotified(nowMs, event);
      // 「持续响铃」 is a promise one Bark request cannot keep (~30 s of ring,
      // and only where the level lets it through); see repeatTick.
      armRepeat(clippedTitle, clippedBody, nowMs, event, options.repeat === true);
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
  const event = rawEvent as NotifyEvent;
  const rawTitle = typeof args.title === "string" ? args.title.trim() : "";
  const rawMessage = typeof args.message === "string" ? args.message.trim() : "";
  const title = rawTitle || NOTIFY_DEFAULT_TITLE;
  const body = rawMessage || NOTIFY_PHRASES[event];
  // `record` for the tool call itself happens in the dispatcher's invoke();
  // this just answers with the structured outcome the schema promises.
  // No presentation options: level and ring come from the operator's settings
  // for this event, which is the only place that knowledge exists.
  return await pushNotification(resolveNotifySettings(), event, title, body, Date.now());
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
 * The task-done hook: one push per set_todos call, naming the items
 * (a batch completion pages as one message — 2 s apart, 30 completed items
 * become 30 pages, not 2). Best-effort by design — the bell observes the
 * work list, it never gates it. The `notify.onTaskDone` switch is checked
 * inside pushNotification, so it suppresses here without a duplicated rule.
 */
export function pushTodoCompletions(previous: readonly unknown[], next: readonly unknown[]): void {
  const settings = resolveNotifySettings();
  // `usable`: pushNotification plays the local sound before it touches Bark,
  // so a sound-only setup still gets its completion chime.
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
  /** Any channel can reach the operator; see notify-routing.ts. */
  canSpeak: boolean;
  idleMinutes: number;
  nowMs: number;
  lastUsedMs: number;
  activeRequests: number;
  hasOpenTodos: boolean;
  notifiedForMs: number;
}): boolean {
  // This watchdog DOES own idleMinutes -- it is the silence threshold, and 0
  // is how the operator turns this specific alert off.
  if (!input.canSpeak || input.idleMinutes <= 0) return false;
  // A request still in flight is the Bridge being slow, not the human being
  // away — do not page anyone over our own processing.
  if (input.activeRequests > 0) return false;
  // A session that never called a tool has nothing to have gone quiet from.
  if (input.lastUsedMs <= 0) return false;
  const idleMs = input.nowMs - input.lastUsedMs;
  if (!Number.isFinite(idleMs) || idleMs < input.idleMinutes * 60_000) return false;
  return input.notifiedForMs !== input.lastUsedMs;
}

/**
 * One summary across all live sessions: the clock the watchdog reads.
 *
 * Exported for the tests that pin the modern-era fold-in: the stateless
 * protocol leaves no session, and a watchdog that cannot see it cannot bell.
 */
export function latestSessionActivity(): { lastUsedMs: number; activeRequests: number; hasOpenTodos: boolean } {
  let lastUsedMs = 0;
  // Both eras count here, because the verdicts below ask one question — "is the
  // Bridge busy right now?" — and a modern request is as busy as a legacy one.
  let activeRequests = state.modernInFlight;
  let hasOpenTodos = false;
  for (const session of state.sessions.values()) {
    if (session.lastUsed > lastUsedMs) lastUsedMs = session.lastUsed;
    activeRequests += session.activeRequests || 0;
    if (session.todos.some(todo => todo && typeof todo === "object" && (todo as TodoLike).status !== "completed")) {
      hasOpenTodos = true;
    }
  }
  // Modern-era (stateless) requests carry no session; their clock is the only
  // trace they leave. Without it a modern-only client was invisible to both
  // watchdogs — busy forever, "nobody connected" in every verdict.
  if (state.modernLastUsed > lastUsedMs) lastUsedMs = state.modernLastUsed;
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
  // The silence alert speaks as "attention": it is telling the operator to
  // come back. Routing it as that event is also what decides whether the
  // desktop sound is eligible, instead of a separate guess here.
  const fire = idleWatchVerdict({
    ...settings,
    ...activity,
    nowMs,
    notifiedForMs: idleNotifiedForMs,
    canSpeak: anyChannelSpeaks("attention", channelStateFor("attention", settings)),
  });
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
 * The idle watchdog above covers silence — nobody said anything for N minutes.
 * That leaves the opposite case uncovered, and it is the common one: the
 * conversation ends cleanly and promptly, so no silence accumulates. The
 * model ticks the last item, writes
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
  /** Any channel can reach the operator; see notify-routing.ts. */
  canSpeak: boolean;
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
  // `canSpeak` comes from the routing table: "can anyone be told" rather than
  // "is the phone on". The first shipped bug was this line asking the wrong
  // question — turning the phone off silenced the desktop sound too.
  //
  // idleMinutes is NOT checked here any more, and that is the second bug:
  // it is the silence alert's threshold, and "0 = 关闭" on that field was
  // quietly disabling the end-of-exchange announcement as well, which has
  // its own switch. A knob may only govern what it owns.
  if (!input.canSpeak) return false;
  // An UNFINISHED list is the idle watchdog's territory, not this one's.
  // Staying out of it is what keeps the two from paging for the same silence.
  if (input.hasTodos && !input.allCompleted) return false;
  if (input.activeRequests > 0) return false;
  if (!Number.isFinite(input.completedAtMs) || input.completedAtMs <= 0) return false;
  // The model already said it — that is the outcome we wanted, stay quiet.
  //
  // The tolerance is not slack, it is a correction. A notify call marks itself
  // at the moment the push lands, but `completedAtMs` is the session's
  // lastUsed, which the SAME call updates when it finishes a moment later. So
  // a model that ends a turn with notify() always records its push two or
  // three milliseconds BEFORE the completion it was announcing, the comparison
  // reads "nothing said since", and the watchdog pages a second time 45s
  // later. Measured in this repo's audit log: push at 22:39:46.674, request
  // completed at 22:39:46.676, duplicate at 22:40:32.
  //
  // Any window that spans one request would do; a minute is chosen because it
  // also covers the ordinary shape of "notify, then a last tool call or two,
  // then stop" — pushing and then tidying up is still the model announcing
  // this ending, not a new one.
  if (input.notifiedSinceMs >= input.completedAtMs - SELF_NOTIFY_TOLERANCE_MS) return false;
  // One settle delay for both endings, by explicit operator choice: getting
  // told promptly is the whole point of the channel, and a listless
  // conversation should not have to wait out the idle threshold to be
  // reported. The cost is accepted and real — 45 s of quiet while someone
  // reads a long answer will be announced as an ending, then corrected by the
  // latch as soon as the next call lands.
  // The cap applies only to a POSITIVE idle setting ("this small a knob must
  // not be outlived by the delay"). idleMinutes 0 switches the silence
  // watchdog off and must NOT collapse the settle delay to zero - that used
  // to fire this bell instantly after every last call, undoing the
  // model's-notify-wins race the settle exists to protect.
  const settleMs = input.idleMinutes > 0
    ? Math.min(FINISH_SETTLE_MS, input.idleMinutes * 60_000)
    : FINISH_SETTLE_MS;
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

/**
 * How far before a "completion" a self-push still counts as announcing it.
 *
 * See finishNoticeVerdict: a push is always recorded slightly before the call
 * that carried it finishes, so an exact comparison can never see the model's
 * own announcement.
 */
const SELF_NOTIFY_TOLERANCE_MS = 60_000;

/** Latch: the completion clock we have already announced. */
let finishAnnouncedForMs = 0;

/**
 * Which pushes count as having told the operator about an ENDING.
 *
 * The three ending-shaped events all mean "come back": `finished` says the
 * exchange is over, `waiting` that a question is holding everything up, and
 * `attention` that a decision is needed. `progress` is the one that does not —
 * it reports that a step completed, which is just as true in the middle of an
 * hour of continued work. Letting it answer for the ending is how the fallback
 * bell went unheard: a todo ticked 30 s before the model went quiet silenced
 * the watchdog for that whole episode, so the operator got a "2 项完成" ping
 * and then nothing at all when the exchange actually ended.
 */
export function announcesEnding(event: NotifyEvent): boolean {
  return event === "finished" || event === "waiting" || event === "attention";
}

/** Set when the AI announced an ending itself; silences the finish watchdog. */
let lastEndingSelfNotifyMs = 0;

/**
 * The clock the finish watchdog compares against, exported so a test can watch
 * it: this is the state the bug lived in, and asserting on the verdict alone
 * would not have caught it.
 */
export function selfNotifyAnnouncementMs(): number {
  return lastEndingSelfNotifyMs;
}

/**
 * Called on every successful push; only an ending-shaped event moves the clock,
 * so a progress push leaves the fallback armed.
 */
export function markSelfNotified(atMs: number = Date.now(), event: NotifyEvent = "finished"): void {
  if (!announcesEnding(event)) return;
  if (atMs > lastEndingSelfNotifyMs) lastEndingSelfNotifyMs = atMs;
}

/**
 * When the current list became fully completed, and whether it is.
 *
 * `completedAtMs` uses the newest session clock rather than a stored
 * timestamp: the moment of completion IS the `set_todos` call that finished
 * it, and that call is the session's `lastUsed`. Reading it here keeps this
 * free of extra bookkeeping in the write path.
 */
/** Exported for the same reason as latestSessionActivity: the fold-in is the rule. */
export function completionSnapshot(): { hasTodos: boolean; allCompleted: boolean; completedAtMs: number } {
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
  //
  // A modern-era (stateless) request leaves no session, so its clock is folded
  // in here too — otherwise a modern-only conversation had no completion time
  // and could never be announced at all.
  if (!hasTodos) return { hasTodos, allCompleted, completedAtMs: Math.max(latestActivityMs, state.modernLastUsed) };
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
    canSpeak: anyChannelSpeaks("finished", channelStateFor("finished", settings)),
    notifiedSinceMs: selfNotifyAnnouncementMs(),
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
 * 「持续响铃直到点开」, which a single Bark request cannot deliver.
 *
 * The operator asked the question himself, quoting the URL this switch
 * produces: `https://api.day.app/<key>/持续响铃?call=1` — 「这个不就是持续响铃吗？」.
 * Measured against Bark's own documentation, it is not: `call=1` repeats the
 * ringtone for about 30 seconds and then stops, and it reaches the speaker at
 * all only when the interruption level allows sound (critical, to beat the mute
 * switch). The switch therefore promised something no single request can keep,
 * and the server is the only side able to keep it — because the server, unlike
 * the phone, can tell whether the human came back.
 *
 * One episode = one armed message: the push that opened it, then repeats of the
 * same text on the shared sweep until someone answers (any request the AI makes
 * afterwards means a human asked it to), until the cap is reached, or until the
 * switch or the channel goes away under it.
 */
export interface RepeatArm {
  event: NotifyEvent;
  title: string;
  body: string;
  /** When the episode's first push landed; acknowledgements compare to this. */
  armedAtMs: number;
  /** When the most recent push of this episode landed. */
  pushedMs: number;
  /** Pushes sent in this episode, the first one included. */
  count: number;
}

/** How long one ring lasts before the server arms the phone again. */
export const REPEAT_INTERVAL_MS = 45_000;
/** Pushes per episode, so a phone left on a desk does not ring all afternoon. */
export const REPEAT_MAX_PUSHES = 10;
/** Hard stop for one episode, independent of the cap. */
export const REPEAT_WINDOW_MS = 15 * 60_000;

/**
 * How long after `armedAtMs` a stamp may still belong to the arming call.
 *
 * `latestSessionActivity()` is stamped when a request FINISHES as well as when
 * it arrives, and the push that arms an episode happens inside a request — so
 * the arming call's own tail lands a few hundred milliseconds after the arm,
 * and reading that as an acknowledgement is what would make the switch ring
 * exactly once (the state the operator complained about). The window is several
 * times the longest plausible tail (a Bark push round trip); a real
 * acknowledgement cannot be that fast, since a human has to read the
 * notification and reply.
 */
export const REPEAT_ACK_TAIL_MS = 5_000;

let repeatArm: RepeatArm | null = null;

/**
 * Repeat, wait, or give up. Pure, so the policy is testable without a phone.
 *
 * `acknowledgedAtMs` is the bridge's own activity clock: a request that started
 * after the episode began cannot have been caused by anything but a human,
 * because the AI only runs when one has asked it to. That is the closest thing
 * to 「点开」 this protocol offers — Bark has no callback for a tapped
 * notification, so "the operator is here" is inferred from work resuming.
 */
export function repeatVerdict(input: {
  nowMs: number;
  armedAtMs: number;
  pushedMs: number;
  count: number;
  acknowledgedAtMs: number;
  /** The per-event 「持续响铃」 switch is still on. */
  switchOn: boolean;
  /** Anyone can still be reached at all (see notify-routing.ts). */
  canSpeak: boolean;
}): "wait" | "repeat" | "stop" {
  if (!input.switchOn || !input.canSpeak) return "stop";
  if (input.acknowledgedAtMs > input.armedAtMs + REPEAT_ACK_TAIL_MS) return "stop";
  if (input.count >= REPEAT_MAX_PUSHES) return "stop";
  if (input.nowMs - input.armedAtMs >= REPEAT_WINDOW_MS) return "stop";
  if (input.nowMs - input.pushedMs < REPEAT_INTERVAL_MS) return "wait";
  return "repeat";
}

/**
 * Remember — or extend — the episode a delivered push just opened.
 *
 * `isRepeat` is the whole difference between the two ways a push arrives here:
 * the server ringing again extends the episode it is already in, while anything
 * the AI says starts a new one — including for a different event, which is how
 * a stale ring is dropped the moment newer news arrives.
 */
function armRepeat(title: string, body: string, atMs: number, event: NotifyEvent, isRepeat: boolean): void {
  if (!callEnabledFor(event)) {
    repeatArm = null;
    return;
  }
  if (isRepeat && repeatArm && repeatArm.event === event) {
    repeatArm = { ...repeatArm, pushedMs: atMs, count: repeatArm.count + 1 };
    return;
  }
  repeatArm = { event, title, body, armedAtMs: atMs, pushedMs: atMs, count: 1 };
}

/** The running episode; exported so a test (or a view) can see it. */
export function currentRepeatArm(): RepeatArm | null {
  return repeatArm;
}

/** Forget the running episode (restart, teardown, or a newer message). */
export function clearRepeat(): void {
  repeatArm = null;
}

/**
 * One pass of the repeat sweep, riding the same 60 s tick as the two watchdogs
 * — which is also why REPEAT_INTERVAL_MS sits a little under a minute: a ring
 * lasts ~30 s, and the point is to have the next one already going.
 */
export function repeatTick(nowMs: number = Date.now()): boolean {
  const armed = repeatArm;
  if (!armed) return false;
  const settings = resolveNotifySettings();
  const verdict = repeatVerdict({
    nowMs,
    armedAtMs: armed.armedAtMs,
    pushedMs: armed.pushedMs,
    count: armed.count,
    acknowledgedAtMs: latestSessionActivity().lastUsedMs,
    switchOn: callEnabledFor(armed.event),
    canSpeak: anyChannelSpeaks(armed.event, channelStateFor(armed.event, settings)),
  });
  if (verdict !== "repeat") {
    if (verdict === "stop") repeatArm = null;
    return false;
  }
  // Both flags on purpose: `repeat` keeps armRepeat from starting this episode
  // over (it is the same one), and the ledger is bypassed because its window
  // exists to stop the AI repeating itself — this push is the server deciding
  // to ring again, and the cap above is what bounds it.
  void pushNotification(settings, armed.event, armed.title, armed.body, nowMs, {
    repeat: true, bypassLedger: true,
  }).then(outcome => { if (!outcome.delivered) repeatArm = null; }).catch(() => { repeatArm = null; });
  return true;
}

/**
 * What a connect-time AI is told about notifications. Pure; a real
 * suffix only appears while the channel is actually usable (so a connect
 * never carries a lecture about machinery it cannot reach), and the text
 * changes with the mode so the model knows what the machine will accept.
 */
export function notifyUsageInstructions(settings: NotifySettings): string {
  // The text talks about Bark levels and switches, so it is gated on Bark.
  // A sound-only machine still gets notified; it just has nothing to read
  // about ringtones and Focus modes.
  if (!settings.barkUsable) return "";
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
  // A previous run's ending announcement is as stale as its rate budget: an
  // in-process restart must not inherit a mark that silences the new run's
  // first ending.
  lastEndingSelfNotifyMs = 0;
  // Same for a ring in progress: a stopped bridge must not come back up
  // ringing about something that happened before the restart.
  repeatArm = null;
}
