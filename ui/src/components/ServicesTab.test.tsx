import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ServicesTab } from "./ServicesTab";
import type { ServiceView } from "../api";

const { servicesMock, serviceActionMock } = vi.hoisted(() => ({
  servicesMock: vi.fn(),
  serviceActionMock: vi.fn(),
}));

vi.mock("../api", () => ({
  api: { services: servicesMock, serviceAction: serviceActionMock },
}));

const web = (running: boolean): ServiceView => ({
  name: "web",
  group: "dev",
  command: "npm run dev",
  cwd: "C:\\work\\demo",
  port: 5173,
  health_url: null,
  log_file: "C:\\Users\\aolia\\.open-bridge\\logs\\svc-web.log",
  running,
  command_id: running ? "cmd-1" : null,
});

afterEach(() => {
  cleanup();
  servicesMock.mockReset();
  serviceActionMock.mockReset();
});

describe("ServicesTab", () => {
  test("failed services get a start button, running ones a stop/restart", async () => {
    servicesMock.mockResolvedValue([web(false)]);
    const { container } = render(<ServicesTab />);
    expect(await screen.findByText("web")).toBeTruthy();
    // This table shipped without the shared class once, so it rendered unstyled
    // next to five correctly styled ones.
    expect(container.querySelector("table")?.className).toBe("token-table");
    expect(screen.getByText("已停止")).toBeTruthy();
    expect(screen.getByText("启动")).toBeTruthy();
  });

  test("clicking stop drives the shared service API and repaints from its reply", async () => {
    servicesMock.mockResolvedValue([web(true)]);
    serviceActionMock.mockResolvedValue({ result: { name: "web" }, services: [web(false)] });
    render(<ServicesTab />);
    await screen.findByText("web");
    fireEvent.click(screen.getByText("停止"));
    expect(serviceActionMock).toHaveBeenCalledWith("stop", "web");
    // The note is unique; the row's badge is not (the note says "已停止" too).
    expect(await screen.findByText("web：已停止")).toBeTruthy();
    expect(screen.getAllByText("已停止").length).toBeGreaterThan(0);
  });

  test("an empty list explains where services come from", async () => {
    servicesMock.mockResolvedValue([]);
    render(<ServicesTab />);
    expect(await screen.findByText(/还没有保存过服务/)).toBeTruthy();
  });
});
