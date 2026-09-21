import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolsPage } from "./ToolsPage";
import type { SettingsState, ToolCatalog } from "../api";

const { toolsMock } = vi.hoisted(() => ({ toolsMock: vi.fn() }));
vi.mock("../api", () => ({ api: { tools: toolsMock } }));

const FULL: ToolCatalog = {
  profile: "full",
  count: 2,
  tools: [
    { name: "read_files", description: "read", core: true },
    { name: "script_sandbox", description: "extended", core: false },
  ],
};

const CORE: ToolCatalog = {
  profile: "core",
  count: 1,
  tools: [{ name: "read_files", description: "read", core: true }],
};

function settings(profile: string): SettingsState {
  return { config: { toolProfile: profile } } as unknown as SettingsState;
}

afterEach(() => { cleanup(); toolsMock.mockReset(); });

describe("ToolsPage", () => {
  /**
   * The profile selector was put on this page precisely so the setting and its
   * effect share a screen -- the docstring says filing it under settings made
   * it "a switch with no visible consequence". But the catalog was fetched in
   * an effect with an empty dependency list, so switching to core left the
   * full list on screen: the one page that exists to show the consequence
   * showed the state from before the change, and the operator's evidence that
   * it worked was a list that had not moved.
   */
  test("switching the profile refetches the catalog it governs", async () => {
    toolsMock.mockResolvedValueOnce(FULL).mockResolvedValueOnce(CORE);
    const act = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<ToolsPage settings={settings("full")} act={act} />);

    expect(await screen.findByText("script_sandbox")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("工具集"), { target: { value: "core" } });
    expect(act).toHaveBeenCalledWith({ command: "setConfig", key: "toolProfile", value: "core" });

    // The parent reloads settings after the action; the catalog must follow.
    rerender(<ToolsPage settings={settings("core")} act={act} />);

    await waitFor(() => expect(toolsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("script_sandbox")).toBeNull());
    expect(screen.getByText("read_files")).toBeTruthy();
  });

  test("the catalog is not refetched when unrelated settings change", async () => {
    toolsMock.mockResolvedValue(FULL);
    const act = vi.fn();
    const { rerender } = render(<ToolsPage settings={settings("full")} act={act} />);
    await screen.findByText("script_sandbox");

    rerender(<ToolsPage settings={{ config: { toolProfile: "full", port: 9 } } as unknown as SettingsState} act={act} />);
    await waitFor(() => expect(toolsMock).toHaveBeenCalledTimes(1));
  });

  test("a failed initial load stops the loading skeleton and shows the error", async () => {
    toolsMock.mockRejectedValueOnce(new Error("catalog unavailable")).mockResolvedValueOnce(CORE);
    const act = vi.fn();
    const { container, rerender } = render(<ToolsPage settings={settings("full")} act={act} />);

    expect((await screen.findByRole("alert")).textContent).toContain("catalog unavailable");
    expect(container.querySelector(".skeleton")).toBeNull();

    rerender(<ToolsPage settings={settings("core")} act={act} />);
    expect(await screen.findByText("read_files")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
