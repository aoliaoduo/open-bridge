/**
 * The combinations, exhaustively.
 *
 * Both shipped notification bugs were invisible in any single function and
 * only appeared in a combination: phone off + sound on, and silence-threshold
 * zero + end-of-exchange on. Four events times sixteen channel states is 64
 * cases — small enough to just enumerate, which is the point of having the
 * policy be pure data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeEvent, anyChannelSpeaks, type ChannelState } from "../src/bridge/notify-routing.js";
import { NOTIFY_EVENT_VALUES, type NotifyEvent } from "../src/bridge/notify.js";

const BOOLS = [true, false] as const;

function everyState(): ChannelState[] {
  const out: ChannelState[] = [];
  for (const barkReady of BOOLS) {
    for (const soundReady of BOOLS) {
      for (const onTaskDone of BOOLS) {
        for (const onFinish of BOOLS) {
          out.push({ barkReady, soundReady, onTaskDone, onFinish });
        }
      }
    }
  }
  return out;
}

test("attention and waiting are never silenced by a switch", () => {
  // The rule the whole design hangs on: a question asked into an empty room
  // stalls forever. No setting may swallow these.
  for (const event of ["attention", "waiting"] as const) {
    for (const state of everyState()) {
      const verdict = routeEvent(event, state);
      if (state.barkReady) {
        assert.equal(verdict.bark, true, `${event} must reach a ready phone in ${JSON.stringify(state)}`);
      }
      if (state.soundReady) {
        assert.equal(verdict.sound, true, `${event} must reach a ready speaker in ${JSON.stringify(state)}`);
      }
    }
  }
});

test("a ready channel is never silenced by the OTHER channel being off", () => {
  // Bug #1 in table form: turning the phone off stopped the desktop sound.
  for (const event of NOTIFY_EVENT_VALUES) {
    for (const state of everyState()) {
      const verdict = routeEvent(event, state);
      const soundOnly: ChannelState = { ...state, barkReady: false };
      const phoneOnly: ChannelState = { ...state, soundReady: false };
      if (verdict.sound === true) {
        assert.equal(
          routeEvent(event, soundOnly).sound,
          true,
          `${event}: the speaker stopped because the phone is off — ${JSON.stringify(state)}`,
        );
      }
      if (verdict.bark === true) {
        assert.equal(
          routeEvent(event, phoneOnly).bark,
          true,
          `${event}: the phone stopped because the speaker is off — ${JSON.stringify(state)}`,
        );
      }
    }
  }
});

test("each switch only governs its own event", () => {
  // Bug #2 in table form: one knob disabling an alert it does not own.
  const ready: ChannelState = { barkReady: true, soundReady: true, onTaskDone: true, onFinish: true };

  // onFinish owns 'finished' and nothing else.
  const noFinish = { ...ready, onFinish: false };
  assert.notEqual(routeEvent("finished", noFinish).bark, true, "onFinish=false must stop finished");
  for (const other of ["attention", "waiting", "progress"] as const) {
    assert.equal(routeEvent(other, noFinish).bark, true, `onFinish must not touch ${other}`);
  }

  // onTaskDone owns 'progress' and nothing else.
  const noTasks = { ...ready, onTaskDone: false };
  assert.notEqual(routeEvent("progress", noTasks).bark, true, "onTaskDone=false must stop progress");
  for (const other of ["attention", "waiting", "finished"] as const) {
    assert.equal(routeEvent(other, noTasks).bark, true, `onTaskDone must not touch ${other}`);
  }
});

test("progress never rings the speaker, however it is configured", () => {
  // A chime per ticked todo is how someone ends up disabling everything.
  for (const state of everyState()) {
    assert.equal(routeEvent("progress", state).sound, "not_eligible");
  }
});

test("anyChannelSpeaks agrees with the per-channel verdicts", () => {
  // The watchdogs gate on this one function; it must never disagree with the
  // table it summarises.
  for (const event of NOTIFY_EVENT_VALUES) {
    for (const state of everyState()) {
      const verdict = routeEvent(event, state);
      const expected = verdict.bark === true || verdict.sound === true;
      assert.equal(
        anyChannelSpeaks(event, state),
        expected,
        `${event} ${JSON.stringify(state)}`,
      );
    }
  }
});

test("a quiet channel always says which kind of quiet", () => {
  // "I turned that off" and "that is not set up" need different fixes, so a
  // bare false is not an acceptable answer anywhere in the table.
  const allowed = new Set(["switch_off", "not_ready", "not_eligible"]);
  for (const event of NOTIFY_EVENT_VALUES as readonly NotifyEvent[]) {
    for (const state of everyState()) {
      const verdict = routeEvent(event, state);
      for (const value of [verdict.bark, verdict.sound]) {
        if (value !== true) {
          assert.ok(allowed.has(value), `unexpected reason ${String(value)}`);
        }
      }
    }
  }
});
