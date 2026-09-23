import assert from "node:assert/strict";
import { test } from "node:test";
import { setHost, type Host } from "../src/host/host.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";
import {
  NOTIFY_EVENT_VALUES,
  beginNotificationEpisode,
  buildBarkUrl,
  canAnnounce,
  clearNotifyLedger,
  finishNoticeVerdict,
  notifyTool,
  notifyUsageInstructions,
  pushNotification,
  type NotifySettings,
} from "../src/bridge/tools/notify.js";

const KEY = "aaaaaaaaaaaaaaaaaaaaaa";
const PHONE: NotifySettings = {
  enabled: true,
  barkUsable: true,
  key: KEY,
  serverUrl: "https://api.day.app",
  blocker: "",
};
const SILENT: NotifySettings = { ...PHONE, enabled: false, barkUsable: false, key: "", blocker: "disabled" };

function installHost(config: Record<string, unknown> = {}): void {
  setHost({
    config: {
      get<T>(key: string, fallback: T): T { return (key in config ? config[key] : fallback) as T; },
      async update(): Promise<void> {},
    },
    secrets: { async get() { return undefined; }, async store() {} },
    state: { get<T>(_key: string, fallback: T): T { return fallback; }, async update() {} },
    storageDir: () => "",
    version: () => "test",
    bundledRipgrep: () => undefined,
    projectRoot: () => ".",
    notify: () => {},
    log: () => {},
    ui: { update: () => {}, refresh: () => {} },
  } as Host);
}

test("only waiting and finished are accepted notification events", () => {
  assert.deepEqual(NOTIFY_EVENT_VALUES, ["waiting", "finished"]);
  const tool = TOOL_DEFINITIONS.find(definition => definition.name === "notify");
  assert.ok(tool);
  const schema = tool.inputSchema;
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["event", "message", "title"]);
  assert.deepEqual(schema.required, ["event"]);
  assert.deepEqual((schema.properties?.event as { enum?: unknown })?.enum, NOTIFY_EVENT_VALUES);
});

test("Bark URLs have one fixed time-sensitive persistent delivery shape", () => {
  const url = new URL(buildBarkUrl("https://api.day.app/", KEY, "标题/划", "正文 ?#1"));
  assert.equal(url.pathname, "/aaaaaaaaaaaaaaaaaaaaaa/%E6%A0%87%E9%A2%98%2F%E5%88%92/%E6%AD%A3%E6%96%87%20%3F%231");
  assert.deepEqual(
    [...url.searchParams.entries()].sort(),
    [["call", "1"], ["group", "open-bridge"], ["level", "timeSensitive"]],
  );
});

test("an alert needs either a configured Bark channel or the event's local sound", () => {
  installHost({ "sound.enabled": true, "sound.fileWaiting": "/tmp/wait.wav" });
  assert.equal(canAnnounce(PHONE, "waiting"), true);
  assert.equal(canAnnounce(SILENT, "waiting"), true);
  assert.equal(canAnnounce(SILENT, "finished"), false);
});

test("one persistent Bark alert never schedules a second network push in the same episode", async () => {
  // The deliberately missing local file keeps this test off the network while
  // still exercising the shared episode latch exactly as a real alert does.
  installHost({ "sound.enabled": true, "sound.fileWaiting": "/definitely/missing.wav" });
  clearNotifyLedger();

  const first = await pushNotification(SILENT, "waiting", "Open Bridge", "Need an answer", 1);
  assert.equal(first.reason, "disabled");

  const duplicate = await pushNotification(SILENT, "waiting", "Open Bridge", "Still waiting", 2);
  assert.equal(duplicate.reason, "duplicate", "one persistent Bark alert must not schedule a second network push");

  beginNotificationEpisode();
  const nextRound = await pushNotification(SILENT, "waiting", "Open Bridge", "Need another answer", 3);
  assert.equal(nextRound.reason, "disabled");
});

test("the notify tool rejects removed progress and attention events", async () => {
  await assert.rejects(() => notifyTool({ event: "progress" }), /Unknown event.*waiting, finished/);
  await assert.rejects(() => notifyTool({ event: "attention" }), /Unknown event.*waiting, finished/);
  await assert.rejects(() => notifyTool({}), /Missing "event"/);
});

test("finish fallback waits ten quiet minutes and never duplicates a self notice", () => {
  const base = {
    canSpeak: true,
    nowMs: 700_000,
    lastUsedMs: 100_000,
    activeRequests: 0,
    notifiedSinceMs: 0,
    announcedForMs: 0,
  };
  assert.equal(finishNoticeVerdict(base), true);
  assert.equal(finishNoticeVerdict({ ...base, activeRequests: 1 }), false);
  assert.equal(finishNoticeVerdict({ ...base, canSpeak: false }), false, "disabled channels do not trigger a fallback");
  assert.equal(finishNoticeVerdict({ ...base, lastUsedMs: 100_001 }), false, "one millisecond short of ten minutes stays quiet");
  assert.equal(finishNoticeVerdict({ ...base, notifiedSinceMs: 100_000 }), false);
  assert.equal(finishNoticeVerdict({ ...base, announcedForMs: 100_000 }), false);
});

test("agent instructions prohibit progress noise and server repeats", () => {
  assert.equal(notifyUsageInstructions(SILENT), "");
  const instructions = notifyUsageInstructions(PHONE);
  assert.match(instructions, /notify\(event:"waiting"\) exactly once immediately before, or in the same turn/);
  assert.match(instructions, /Use no notification for progress/);
  assert.match(instructions, /never re-sends it/);
});
