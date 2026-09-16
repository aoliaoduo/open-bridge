import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Presentation — how loud a notification is — belongs to the operator.
 *
 * The settings page carries a level and a ring switch per event, which is the
 * operator stating, once, how much each kind of news is allowed to interrupt
 * them. The notify tool used to accept the same knobs as call arguments and
 * let them win, so a model could hand back `level: "critical"` (pierces silent
 * mode) or `call: 1` (rings until acknowledged) for an event the operator had
 * deliberately set to `passive`. The model cannot read those settings, so it
 * was overruling a preference it could not see, on a guess.
 *
 * These tests pin the contract that replaced it: the knobs are not model-
 * settable at all, and config is the only source of level/call.
 */

/** Install a config whose per-event preference is "stay quiet". */
async function withQuietProgress(): Promise<void> {
  const { setHost } = await import("../src/host/host.js");
  const cfg = new Map<string, unknown>([
    ["notify.levelProgress", "passive"],
    ["notify.callProgress", false],
    ["notify.levelAttention", "timeSensitive"],
    ["notify.callAttention", false],
  ]);
  setHost({
    config: {
      get: <T,>(key: string, fallback: T): T => (cfg.has(key) ? cfg.get(key) : fallback) as T,
      update: async (): Promise<void> => undefined,
    },
  } as never);
}

test("the notify tool exposes only what the model actually knows", async () => {
  const { notifyToolArgKeys } = await import("../src/bridge/notify.js");
  // event/title/message are facts about what happened. Everything else was a
  // presentation choice the model had to guess at.
  assert.deepEqual([...notifyToolArgKeys()].sort(), ["event", "message", "title"]);
});

test("no Bark presentation knob is reachable from a tool call", async () => {
  const { notifyToolArgKeys } = await import("../src/bridge/notify.js");
  const removed = [
    "sound", "level", "volume", "call", "badge", "url",
    "group", "icon", "isArchive", "copy", "autoCopy",
  ];
  const exposed = new Set(notifyToolArgKeys());
  for (const knob of removed) {
    assert.equal(exposed.has(knob), false, `"${knob}" must not be model-settable`);
  }
});

test("a caller cannot raise the operator's level or start a ring", async () => {
  await withQuietProgress();
  const { withEventDefaults } = await import("../src/bridge/notify.js");
  // The exact shape that used to win. `progress` is configured passive here.
  const merged = withEventDefaults("progress", { level: "critical", call: 1 } as never);
  assert.equal(merged?.level, "passive", "config owns the level");
  assert.equal(merged?.call, undefined, "config owns the ring");
});

test("the operator's own preferences still reach the push", async () => {
  await withQuietProgress();
  const { withEventDefaults } = await import("../src/bridge/notify.js");
  // Removing the knobs must not remove the settings they used to shadow.
  assert.equal(withEventDefaults("attention")?.level, "timeSensitive");
  assert.equal(withEventDefaults("progress")?.level, "passive");
});

test("the server's own internal pushes keep their deliberate level", async () => {
  await withQuietProgress();
  const { withEventDefaults } = await import("../src/bridge/notify.js");
  // The idle watchdog and the settings-page test button pass a level on
  // purpose: those are the server's own decisions, not a model's guess, and
  // they are the reason the internal channel stays open.
  const internal = withEventDefaults("attention", { level: "timeSensitive" }, { trusted: true });
  assert.equal(internal?.level, "timeSensitive");
});
