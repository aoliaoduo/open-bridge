import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LogsTab } from "./LogsTab";

const { copyTextMock } = vi.hoisted(() => ({ copyTextMock: vi.fn(async () => undefined) }));

vi.mock("../api", () => ({ copyText: copyTextMock }));

/**
 * Controllable stand-in: jsdom ships no EventSource, and the tests need to
 * decide when a line arrives.
 *
 * The callbacks are invoked inside act(): an SSE frame lands outside React's
 * event system, and without act the re-render is not flushed before the
 * assertions read the DOM — which is exactly how the first version of this file
 * "proved" that lines were being dropped.
 */
class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  static last: FakeEventSource | null = null;
  constructor(public url: string) { FakeEventSource.last = this; }
  close(): void { this.closed = true; }

  emit(line: string): void {
    act(() => { this.onmessage?.({ data: JSON.stringify({ line }) }); });
  }
  open(): void { act(() => { this.onopen?.(); }); }
  fail(): void { act(() => { this.onerror?.(); }); }
}

afterEach(() => {
  cleanup();
  copyTextMock.mockClear();
  FakeEventSource.last = null;
  vi.unstubAllGlobals();
});

function renderLogs() {
  vi.stubGlobal("EventSource", FakeEventSource);
  render(<LogsTab />);
  return FakeEventSource.last!;
}

describe("LogsTab", () => {
  test("colours the level it can read out of a line", () => {
    // A wall of same-coloured text is the thing an operator scrolls past
    // without reading; the level word is what makes a line findable.
    const source = renderLogs();

    source.emit("2026-09-12T10:00:00Z INFO bridge started");
    source.emit("2026-09-12T10:00:01Z WARN tunnel retry in 3s");
    source.emit("2026-09-12T10:00:02Z ERROR ngrok exited with code 1");
    source.emit("plain line without a level");

    expect(screen.getByText(/ngrok exited with code 1/).closest(".log-line")?.className).toContain("level-error");
    expect(screen.getByText(/tunnel retry/).closest(".log-line")?.className).toContain("level-warn");
    expect(screen.getByText(/bridge started/).closest(".log-line")?.className).toContain("level-info");
    // A line with no level is shown as-is rather than guessed at.
    expect(screen.getByText("plain line without a level").className).toBe("log-text");
    expect(screen.getByText(/1 条错误/)).toBeTruthy();

    // 暂停 stops new lines landing, and says so instead of looking frozen.
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    source.emit("2026-09-12T10:00:03Z INFO ignored while paused");

    expect(screen.queryByText(/ignored while paused/)).toBeNull();
    expect(screen.getByText("已暂停")).toBeTruthy();
  });

  test("reports how many lines a copy took, and says when there is nothing", async () => {
    const source = renderLogs();

    fireEvent.click(screen.getByRole("button", { name: "复制日志" }));
    expect(screen.getByText("还没有日志可复制。")).toBeTruthy();

    source.emit("2026-09-12T10:00:00Z INFO one");
    source.emit("2026-09-12T10:00:00Z INFO two");
    fireEvent.click(screen.getByRole("button", { name: "复制日志" }));

    expect(copyTextMock).toHaveBeenCalledWith("2026-09-12T10:00:00Z INFO one\n2026-09-12T10:00:00Z INFO two");
    // findByText, not getByText: the confirmation arrives in a promise callback,
    // so the re-render has not been flushed at the moment of the click.
    expect(await screen.findByText("已复制 2 行。")).toBeTruthy();

    // 清空视图 empties the pane and returns it to the waiting state.
    fireEvent.click(screen.getByRole("button", { name: "清空视图" }));
    expect(screen.getByText("等待日志…")).toBeTruthy();
  });

  test("says the stream is disconnected instead of looking quiet", () => {
    const source = renderLogs();

    source.fail();

    expect(screen.getByText(/连接已断开，自动重连中/)).toBeTruthy();
    expect(screen.getByText("已断开，重连中")).toBeTruthy();

    source.open();

    expect(screen.queryByText(/连接已断开，自动重连中/)).toBeNull();
    expect(screen.getByText("实时")).toBeTruthy();
  });
});
