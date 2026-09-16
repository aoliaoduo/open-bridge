import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DraftField } from "./SettingsTab";

/**
 * DraftField holds edits until blur, and rejects a value the server would
 * refuse -- reverting it and saying so, rather than leaving the box showing a
 * value the config does not hold.
 *
 * The rejection used to be reachable only for type="number". The two sound
 * paths are text fields that pass an onInvalid promising "needs an absolute
 * path to an audio file (.wav .mp3 ...)", and that check could never run: any
 * string at all was committed. The server only bounds the length, so a typo
 * was stored happily and surfaced much later as a silent alert -- exactly the
 * case where silence is indistinguishable from "the feature is off".
 */

afterEach(cleanup);

describe("DraftField", () => {
  test("a text field with a validator rejects what the validator refuses", () => {
    const onCommit = vi.fn();
    const onInvalid = vi.fn();
    render(
      <DraftField
        value="/sounds/alert.wav"
        onCommit={onCommit}
        onInvalid={onInvalid}
        validate={(raw: string) => raw.endsWith(".wav")}
      />,
    );
    const input = screen.getByDisplayValue("/sounds/alert.wav");
    fireEvent.change(input, { target: { value: "not-a-path" } });
    fireEvent.blur(input);

    expect(onInvalid).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    // Reverted: the box must not keep showing a value that was not saved.
    expect((input as HTMLInputElement).value).toBe("/sounds/alert.wav");
  });

  test("a valid value still commits", () => {
    const onCommit = vi.fn();
    render(
      <DraftField
        value=""
        onCommit={onCommit}
        onInvalid={vi.fn()}
        validate={(raw: string) => raw.endsWith(".wav")}
      />,
    );
    const input = screen.getByDisplayValue("");
    fireEvent.change(input, { target: { value: "/a.wav" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("/a.wav");
  });

  test("clearing a validated field is allowed: empty means 'no sound'", () => {
    // The placeholder says as much. Running the audio-file check over "" would
    // make the field impossible to unset.
    const onCommit = vi.fn();
    const onInvalid = vi.fn();
    render(
      <DraftField
        value="/sounds/alert.wav"
        onCommit={onCommit}
        onInvalid={onInvalid}
        validate={(raw: string) => raw.endsWith(".wav")}
      />,
    );
    const input = screen.getByDisplayValue("/sounds/alert.wav");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onInvalid).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith("");
  });

  test("with no validator, any text commits as before", () => {
    const onCommit = vi.fn();
    render(<DraftField value="" onCommit={onCommit} />);
    const input = screen.getByDisplayValue("");
    fireEvent.change(input, { target: { value: "anything at all" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("anything at all");
  });
});
