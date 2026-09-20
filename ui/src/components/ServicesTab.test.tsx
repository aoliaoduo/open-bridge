import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  log_file: "C:\\work\\demo\\.open-bridge\\logs\\svc-web.log",
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
    expect(await screen.findByText("web: 已停止")).toBeTruthy();
    expect(screen.getAllByText("已停止").length).toBeGreaterThan(0);
  });

  test("an empty list explains where services come from", async () => {
    servicesMock.mockResolvedValue([]);
    render(<ServicesTab />);
    expect(await screen.findByText(/还没有保存过服务/)).toBeTruthy();
  });
});


describe("ServicesTab concurrent actions", () => {
  test.each(["web", "worker"])("keeps each row busy when %s finishes first", async first => {
    const services = [web(true), { ...web(true), name: "worker", port: 5174 }];
    servicesMock.mockResolvedValue(services);
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    serviceActionMock.mockImplementation((_action: string, name: string) => new Promise((resolve, reject) => {
      pending.set(name, { resolve, reject });
    }));
    render(<ServicesTab />);
    await screen.findByText("worker");
    const restart = (name: string) => within(screen.getByText(name).closest("tr")!)
      .getByRole("button", { name: "重启" }) as HTMLButtonElement;

    fireEvent.click(restart("web"));
    fireEvent.click(restart("worker"));
    fireEvent.click(restart("web"));
    expect(serviceActionMock).toHaveBeenCalledTimes(2);
    expect(serviceActionMock).toHaveBeenNthCalledWith(1, "restart", "web");
    expect(serviceActionMock).toHaveBeenNthCalledWith(2, "restart", "worker");
    expect(restart("web").disabled).toBe(true);
    expect(restart("worker").disabled).toBe(true);

    const other = first === "web" ? "worker" : "web";
    await act(async () => { pending.get(first)!.resolve({ result: {}, services }); });
    expect(restart(first).disabled).toBe(false);
    expect(restart(other).disabled).toBe(true);
    fireEvent.click(restart(other));
    expect(serviceActionMock).toHaveBeenCalledTimes(2);

    await act(async () => { pending.get(other)!.reject(new Error(`${other}: restart failed`)); });
    expect(screen.getByText(`${other}: restart failed`)).toBeTruthy();
    expect(restart("web").disabled).toBe(false);
    expect(restart("worker").disabled).toBe(false);

    serviceActionMock.mockResolvedValueOnce({ result: {}, services });
    await act(async () => { fireEvent.click(restart(other)); });
    expect(serviceActionMock).toHaveBeenCalledTimes(3);
  });

  test("rejects same-row re-entry before React paints the disabled button", async () => {
    servicesMock.mockResolvedValue([web(true)]);
    serviceActionMock.mockReturnValue(new Promise(() => {}));
    render(<ServicesTab />);
    await screen.findByText("web");
    const button = screen.getByRole("button", { name: "重启" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(serviceActionMock).toHaveBeenCalledTimes(1);
  });
});
