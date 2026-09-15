/**
 * One table that answers: for this event, which channels may speak, and what
 * has to be true for each of them.
 *
 * Why this exists. The rules used to be spread across four places — an
 * ALWAYS_EVENTS set, an eventSuppressed() function, a compound condition at
 * the top of each watchdog verdict, and a switch inside soundFileForEvent.
 * Every one of them was correct in isolation. Two bugs still shipped, both
 * the same shape: a knob silencing a channel it does not own.
 *
 *   - `notify.enabled` (the PHONE switch) gated `usable`, which the watchdogs
 *     checked first — so turning the phone off stopped the desktop sound too.
 *   - `notify.idleMinutes` (the SILENCE threshold) sat in the same condition
 *     as the end-of-exchange check — so "0 = off" for one alert also disabled
 *     a different alert that has its own switch.
 *
 * Neither is visible while reading any single function: you have to hold four
 * files in your head and notice that a flag's name is broader than what it
 * tests. A table makes the question answerable by looking, and makes the
 * combinations enumerable by a test.
 */

import type { NotifyEvent } from "./notify.js";

/** The ways an operator can be reached. Add a channel here, not in an if. */
export type NotifyChannel = "bark" | "sound";

/**
 * What the router needs to know. Deliberately plain data: no config reads, no
 * clock, no I/O — so the whole policy can be exercised without a bridge.
 */
export interface ChannelState {
  /** Phone: master switch AND a usable device key. */
  barkReady: boolean;
  /** Desktop: the sound switch AND a file configured for THIS event. */
  soundReady: boolean;
  /** 每项任务完成时通知 — progress and todo completions. */
  onTaskDone: boolean;
  /** 对话结束时通知 — the end-of-exchange bell. */
  onFinish: boolean;
}

/**
 * Which switch, if any, owns an event.
 *
 * `null` means the event is unconditional. attention and waiting are not
 * optional: an unanswered question stalls the exchange indefinitely and the
 * operator has no way to find out except by looking at the screen, which is
 * the exact thing the notification exists to prevent. A setting that can
 * swallow those is a setting that can strand you.
 */
const OWNING_SWITCH: Record<NotifyEvent, keyof Pick<ChannelState, "onTaskDone" | "onFinish"> | null> = {
  attention: null,
  waiting: null,
  finished: "onFinish",
  progress: "onTaskDone",
};

/**
 * Channels allowed to carry each event, before per-channel readiness.
 *
 * Progress is phone-only on purpose: a chime on every ticked todo is the
 * fastest way to make someone disable the whole feature, and then the alerts
 * that mattered are gone with it.
 */
const ELIGIBLE_CHANNELS: Record<NotifyEvent, readonly NotifyChannel[]> = {
  attention: ["bark", "sound"],
  waiting: ["bark", "sound"],
  finished: ["bark", "sound"],
  progress: ["bark"],
};

/** Why a channel stayed quiet, in the vocabulary the console already uses. */
export type QuietReason = "switch_off" | "not_ready" | "not_eligible";

export interface ChannelVerdict {
  bark: true | QuietReason;
  sound: true | QuietReason;
}

/**
 * Decide, per channel, whether this event may be announced.
 *
 * Pure and total: every channel gets an answer, and the answer says why.
 * "Why" matters because the two failure modes an operator hits — "I turned
 * that off" and "that is not configured" — need different fixes, and a bare
 * false cannot tell them apart.
 */
export function routeEvent(event: NotifyEvent, state: ChannelState): ChannelVerdict {
  const owner = OWNING_SWITCH[event];
  const switchedOff = owner !== null && !state[owner];

  const decide = (channel: NotifyChannel): true | QuietReason => {
    if (!ELIGIBLE_CHANNELS[event].includes(channel)) return "not_eligible";
    if (switchedOff) return "switch_off";
    const ready = channel === "bark" ? state.barkReady : state.soundReady;
    return ready ? true : "not_ready";
  };

  return { bark: decide("bark"), sound: decide("sound") };
}

/**
 * Can this event reach the operator at all?
 *
 * The watchdogs ask this instead of checking one channel's flag. That is the
 * whole fix for the first bug: "can anyone be told" is a different question
 * from "is the phone on", and only this function is allowed to answer it.
 */
export function anyChannelSpeaks(event: NotifyEvent, state: ChannelState): boolean {
  const verdict = routeEvent(event, state);
  return verdict.bark === true || verdict.sound === true;
}
