/**
 * Phone and local notifications for the two moments that genuinely need a
 * person: the AI is waiting for an answer, or a conversation has stopped.
 *
 * Every alert is one persistent Bark request (`call=1`) and one optional local
 * sound. The Bridge never re-sends that alert. A later ordinary tool call
 * begins a new activity episode and may therefore notify again if it later
 * blocks or ends.
 */

import { probeHttpHealth } from "../network/safe-probe.js";
import { host } from "../host/host.js";
import { playAlertSound, soundFileForEvent } from "./sound-alert.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { canonicalBarkOrigin, parseBarkKeyInput } from "./config-values.js";
import { record, state } from "./state.js";
import type { JsonArgs } from "./json-args.js";

export const NOTIFY_EVENT_VALUES = ["waiting", "finished"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENT_VALUES)[number];

const BARK_TIMEOUT_MS = 8_000;
const BARK_BODY_LIMIT = 500;
const BARK_TITLE_LIMIT = 120;
// A fallback is deliberately late: an agent can be thinking or working outside
// the Bridge, so a brief quiet period is not evidence that its task ended.
const FINISH_SETTLE_MS = 10 * 60 * 1000;
const SELF_NOTIFY_TOLERANCE_MS = 60_000;
const BARK_DEFAULT_URL = CONFIG_DEFAULTS["notify.serverUrl"] as string;
export const NOTIFY_DEFAULT_TITLE = "Open Bridge";

export interface NotifySettings {
  enabled: boolean;
  barkUsable: boolean;
  /** Already parsed; never returned through an MCP tool. */
  key: string;
  serverUrl: string;
  /** "disabled" or "no_key" when the phone channel cannot send. */
  blocker: string;
}

export interface NotifyOutcome {
  /** Did the phone push reach Bark? */
  delivered: boolean;
  event: NotifyEvent;
  /** "" on delivery; otherwise a stable, actionable reason. */
  reason: string;
  status: number;
  error: string;
  /** Did the configured local sound start? */
  sounded: boolean;
  /** Did either channel announce the alert? */
  announced: boolean;
}

/** Read and normalize the small notification configuration surface. */
export function resolveNotifySettings(): NotifySettings {
  const cfg = host().config;
  const enabled = cfg.get("notify.enabled", CONFIG_DEFAULTS["notify.enabled"]) === true;
  const rawKey = cfg.get("notify.barkKey", CONFIG_DEFAULTS["notify.barkKey"]);
  const key = typeof rawKey === "string" ? (parseBarkKeyInput(rawKey) ?? "") : "";
  let serverUrl = BARK_DEFAULT_URL;
  try {
    serverUrl = canonicalBarkOrigin(String(cfg.get("notify.serverUrl", BARK_DEFAULT_URL) || BARK_DEFAULT_URL));
  } catch {
    // A malformed hand-edited value must not redirect an alert to an arbitrary host.
  }
  return {
    enabled,
    barkUsable: enabled && Boolean(key),
    key,
    serverUrl,
    blocker: !enabled ? "disabled" : key ? "" : "no_key",
  };
}

/** A notification can use Bark, the event's local sound, or both. */
export function canAnnounce(settings: NotifySettings, event: NotifyEvent): boolean {
  return settings.barkUsable || Boolean(soundFileForEvent(event));
}

/**
 * Bark's normal URL form. Alerts deliberately use one consistent presentation:
 * time-sensitive delivery and `call=1`. `call=1` is one Bark request; Open
 * Bridge does not emulate persistence by sending a second request later.
 */
export function buildBarkUrl(serverUrl: string, key: string, title: string, body: string): string {
  const origin = serverUrl.replace(/\/+$/u, "");
  const segments = [title, body].filter(part => part.length > 0).map(part => `/${encodeURIComponent(part)}`);
  const query = new URLSearchParams({
    group: "open-bridge",
    level: "timeSensitive",
    call: "1",
  });
  return `${origin}/${encodeURIComponent(key)}${segments.join("")}?${query.toString()}`;
}

/** The only choices a model may make are what happened and the human wording. */
export function notifyToolArgKeys(): readonly string[] {
  return ["event", "title", "message"];
}

/**
 * One alert is enough while work is stopped. This latch is reset only when the
 * Bridge begins another ordinary tool call, which is the observable sign that
 * the operator and AI are moving again.
 */
let alertSentInEpisode = false;

export function beginNotificationEpisode(): void {
  alertSentInEpisode = false;
}

export function notificationEpisodeIsAlerted(): boolean {
  return alertSentInEpisode;
}

export async function pushNotification(
  settings: NotifySettings,
  event: NotifyEvent,
  title: string,
  body: string,
  nowMs: number = Date.now(),
  options: { bypassEpisode?: boolean; silentLocally?: boolean } = {},
): Promise<NotifyOutcome> {
  let sounded = false;
  const outcome = (delivered: boolean, reason: string, status = 0, error = ""): NotifyOutcome =>
    ({ delivered, event, reason, status, error, sounded, announced: delivered || sounded });

  const clippedTitle = title.trim().slice(0, BARK_TITLE_LIMIT);
  const clippedBody = body.replace(/\r\n?/g, "\n").trim().slice(0, BARK_BODY_LIMIT);
  const soundFile = options.silentLocally ? "" : soundFileForEvent(event);
  const hasSound = Boolean(soundFile);

  if (!settings.barkUsable && !hasSound) {
    return logged(outcome(false, settings.blocker || "not_ready"), clippedTitle);
  }
  if (!options.bypassEpisode && alertSentInEpisode) {
    return logged(outcome(false, "duplicate"), clippedTitle);
  }
  if (!options.bypassEpisode) alertSentInEpisode = true;

  if (soundFile) {
    sounded = playAlertSound(soundFile).played;
    if (sounded) markSelfNotified(nowMs);
  }

  // A sound-only setup is still a successful announcement. Preserve the phone
  // failure reason because callers may want to show why Bark itself stayed quiet.
  if (!settings.barkUsable) {
    return logged(outcome(false, settings.blocker || "not_ready"), clippedTitle);
  }

  const url = buildBarkUrl(settings.serverUrl, settings.key, clippedTitle, clippedBody);
  try {
    const probe = await probeHttpHealth(url, { timeoutMs: BARK_TIMEOUT_MS });
    if (probe.ok) {
      markSelfNotified(nowMs);
      return logged(outcome(true, "", probe.status), clippedTitle);
    }
    return logged(outcome(false, "send_failed", probe.status, probe.error || `Bark responded with HTTP ${probe.status}`), clippedTitle);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return logged(outcome(false, "send_failed", 0, detail), clippedTitle);
  }
}

function logged(result: NotifyOutcome, title: string): NotifyOutcome {
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

const NOTIFY_PHRASES: Record<NotifyEvent, string> = {
  waiting: "AI 正在等你回答或选择；不回复它就无法继续。",
  finished: "这一轮对话已经结束，可以回来查看结果。",
};

export async function notifyTool(args: JsonArgs): Promise<NotifyOutcome> {
  const rawEvent = typeof args.event === "string" ? args.event.trim() : "";
  if (!rawEvent) {
    throw new Error(`Missing "event": pass one of: ${NOTIFY_EVENT_VALUES.join(", ")}. (expected 'event': string)`);
  }
  if (!(NOTIFY_EVENT_VALUES as readonly string[]).includes(rawEvent)) {
    throw new Error(`Unknown event "${rawEvent}". Pass one of: ${NOTIFY_EVENT_VALUES.join(", ")}.`);
  }
  const event = rawEvent as NotifyEvent;
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : NOTIFY_DEFAULT_TITLE;
  const body = typeof args.message === "string" && args.message.trim() ? args.message.trim() : NOTIFY_PHRASES[event];
  return pushNotification(resolveNotifySettings(), event, title, body);
}

/** Aggregate activity across both MCP protocol eras. */
export function latestSessionActivity(): { lastUsedMs: number; activeRequests: number } {
  let lastUsedMs = state.modernLastUsed;
  let activeRequests = state.modernInFlight;
  for (const session of state.sessions.values()) {
    if (session.lastUsed > lastUsedMs) lastUsedMs = session.lastUsed;
    activeRequests += session.activeRequests || 0;
  }
  return { lastUsedMs, activeRequests };
}

export function finishNoticeVerdict(input: {
  canSpeak: boolean;
  nowMs: number;
  lastUsedMs: number;
  activeRequests: number;
  notifiedSinceMs: number;
  announcedForMs: number;
}): boolean {
  if (!input.canSpeak || input.activeRequests > 0) return false;
  if (!Number.isFinite(input.lastUsedMs) || input.lastUsedMs <= 0) return false;
  // A manual waiting/finished alert describes this same stopping episode.
  if (input.notifiedSinceMs > 0 && input.notifiedSinceMs >= input.lastUsedMs - SELF_NOTIFY_TOLERANCE_MS) return false;
  if (input.nowMs - input.lastUsedMs < FINISH_SETTLE_MS) return false;
  return input.announcedForMs !== input.lastUsedMs;
}

let finishAnnouncedForMs = 0;
let lastEndingSelfNotifyMs = 0;

export function selfNotifyAnnouncementMs(): number {
  return lastEndingSelfNotifyMs;
}

function markSelfNotified(atMs: number): void {
  if (atMs > lastEndingSelfNotifyMs) lastEndingSelfNotifyMs = atMs;
}

/** The server's one-shot fallback when an agent ends without notifying itself. */
export function finishNoticeTick(nowMs: number = Date.now()): boolean {
  const settings = resolveNotifySettings();
  const activity = latestSessionActivity();
  if (!finishNoticeVerdict({
    ...activity,
    nowMs,
    canSpeak: canAnnounce(settings, "finished"),
    notifiedSinceMs: selfNotifyAnnouncementMs(),
    announcedForMs: finishAnnouncedForMs,
  })) return false;

  finishAnnouncedForMs = activity.lastUsedMs;
  const body = "AI 已停止；这一轮对话可以回来查看结果。";
  void pushNotification(settings, "finished", NOTIFY_DEFAULT_TITLE, body, nowMs).catch(() => undefined);
  return true;
}

/** The short, unambiguous contract injected into a connected agent's context. */
export function notifyUsageInstructions(settings: NotifySettings): string {
  if (!settings.barkUsable) return "";
  return "\n\n# Phone notifications (Bark)\n"
    + "Call notify(event:\"waiting\") exactly once immediately before, or in the same turn as, you ask the operator a question or present a choice that blocks further work. Do this before any question UI that pauses your turn. "
    + "Use no notification for progress or completed todo items. When an exchange is genuinely finished, call notify(event:\"finished\") once as your final action; if you forget, the Bridge sends one fallback only after a fixed ten-minute settle delay. "
    + "Each alert is one persistent Bark notification (call=1); the Bridge never re-sends it and suppresses duplicates until ordinary work resumes.";
}

/** Clear process-lifetime latches during clean shutdown or restart. */
export function clearNotifyLedger(): void {
  alertSentInEpisode = false;
  finishAnnouncedForMs = 0;
  lastEndingSelfNotifyMs = 0;
}
