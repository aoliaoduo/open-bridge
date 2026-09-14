import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExecutablePicker } from "./ExecutablePicker";
import type { ExecutableChoice } from "../api";

/**
 * The point of this control is that nobody has to know where Git Bash lives.
 * These tests hold the two halves of that promise: what the machine has is
 * offered as a choice, and what the machine missed can still be typed in.
 */

const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

const shells: ExecutableChoice[] = [
  { value: gitBash, label: "Git Bash", available: true },
  { value: pwsh, label: "PowerShell 7", available: true },
];

function picker(value: string, onCommit = vi.fn(), choices = shells) {
  render(
    <ExecutablePicker
      value={value}
      choices={choices}
      autoValues={[""]}
      autoLabel={choices[0] ? `${choices[0].label} — ${choices[0].value}` : "a guess"}
      onCommit={onCommit}
      placeholder="full path"
    />,
  );
  return { onCommit, select: screen.getByRole("combobox") as HTMLSelectElement };
}

afterEach(cleanup);

describe("ExecutablePicker", () => {
  test("what 自动 will actually run is named, not left to faith", () => {
    const { select } = picker("");
    expect(select.value).toBe("__auto__");
    // "Automatic" alone tells the operator nothing about which shell they got.
    expect(screen.getByRole("option", { name: `自动（Git Bash — ${gitBash}）` })).toBeTruthy();
  });

  test("every detected executable is offered with its label and its path", () => {
    picker("");
    // The label alone is ambiguous when two copies of ngrok are installed, and
    // the path alone is unreadable; the row carries both.
    expect(screen.getByRole("option", { name: `Git Bash — ${gitBash}` })).toBeTruthy();
    expect(screen.getByRole("option", { name: `PowerShell 7 — ${pwsh}` })).toBeTruthy();
  });

  test("picking one stores the path, and picking 自动 stores the empty value", () => {
    const { onCommit, select } = picker("");
    fireEvent.change(select, { target: { value: pwsh } });
    expect(onCommit).toHaveBeenCalledWith(pwsh);

    cleanup();
    const auto = picker(pwsh);
    fireEvent.change(auto.select, { target: { value: "__auto__" } });
    // Not the resolved path: storing "" keeps following detection, so a later
    // Git Bash install is picked up instead of being frozen out.
    expect(auto.onCommit).toHaveBeenCalledWith("");
  });

  test("a path detection cannot see is kept, and shown in the box that holds it", () => {
    // Someone built their own shell, or installed to a place nobody probes.
    // Re-selecting something 'known' on their behalf would be a silent
    // override of a deliberate choice.
    picker("D:\\custom\\fish.exe");
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("__manual__");
    expect(screen.getByDisplayValue("D:\\custom\\fish.exe")).toBeTruthy();
  });

  test("手动填写 is always available, because detection is not exhaustive", () => {
    const { onCommit, select } = picker("");
    expect(screen.queryByPlaceholderText("full path")).toBeNull();

    fireEvent.change(select, { target: { value: "__manual__" } });
    const input = screen.getByPlaceholderText("full path");
    // Switching to manual must not itself write anything: the operator has not
    // said what they want yet.
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "D:\\tools\\bash.exe" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("D:\\tools\\bash.exe");
  });

  test("a machine where nothing was found still offers 自动 and a text box", () => {
    // The empty list is the case that used to be the only case; it must remain
    // usable rather than becoming a dropdown with one dead entry.
    const { select } = picker("", vi.fn(), []);
    expect(screen.getByRole("option", { name: "自动（a guess）" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "__manual__" } });
    expect(screen.getByPlaceholderText("full path")).toBeTruthy();
  });
});
