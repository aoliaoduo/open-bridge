import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HealthPage } from "./HealthPage";
import type { HealthReport } from "../api";

const { healthMock } = vi.hoisted(() => ({ healthMock: vi.fn() }));

vi.mock("../api", () => ({ api: { health: healthMock } }));

afterEach(() => {
  cleanup();
  healthMock.mockReset();
});

/** The exact shape the running instance sends, `build` included. */
function healthReport(): HealthReport {
  return {
    exposure: "public-open",
    checks: [
      { name: "instance", level: "ok", ok: true, detail: "state=running" },
      { name: "workspace", level: "ok", ok: true, detail: "C:\\ws" },
      { name: "tools", level: "ok", ok: true, detail: "56 个（full）" },
      { name: "build", level: "ok", ok: true, detail: "与运行中的实例一致" },
      { name: "tunnel", level: "ok", ok: true, detail: "owner" },
      { name: "public", level: "ok", ok: true, detail: "HTTP 200" },
      { name: "exposure", level: "warn", ok: false, detail: "公网可达且未开启鉴权" },
    ],
  };
}

function renderPage() {
  const onOpen = vi.fn();
  render(<HealthPage onOpen={onOpen} />);
  return { onOpen };
}

describe("HealthPage", () => {
  test("a failed initial check stops looking like an endless health run", async () => {
    healthMock.mockRejectedValueOnce(new Error("health unavailable"));
    const { container } = render(<HealthPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("health unavailable");
    expect(container.querySelector(".skeleton")).toBeNull();
  });

  test("labels the 构建 row like every other row", async () => {
    // The build check arrived after the label map did, so this page showed the
    // raw English check name in a table where everything else is Chinese.
    healthMock.mockResolvedValue(healthReport());

    renderPage();

    expect(await screen.findByText("构建")).toBeTruthy();
    expect(screen.queryByText("build")).toBeNull();
    expect(screen.getByText("与运行中的实例一致")).toBeTruthy();
  });

  test("keeps a warning a warning and a pass a pass", async () => {
    healthMock.mockResolvedValue(healthReport());

    renderPage();

    expect(await screen.findByText("无异常，1 项提醒。")).toBeTruthy();
    expect(screen.getByText("提醒")).toBeTruthy();
    expect(screen.getAllByText("通过")).toHaveLength(6);
  });

  test("scrolls the checks table, not the page, on a narrow window", async () => {
    // Three columns of long paths/detail lines: without a scroll container the
    // whole document scrolled sideways on a phone.
    healthMock.mockResolvedValue(healthReport());

    renderPage();

    const table = await screen.findByRole("table");
    expect(table.parentElement?.className).toContain("table-wrap");
  });
});

describe("HealthPage: summary meter", () => {
  test("shows how much of the run passed, not only a sentence", async () => {
    healthMock.mockResolvedValue(healthReport());

    renderPage();

    expect(await screen.findByText(/6 \/ 7 项已通过/)).toBeTruthy();
    // One 提醒 and no 异常: the bar is amber, not red — the state is a risk the
    // operator may have chosen, not a defect.
    expect(document.querySelector(".meter-fill")?.className).toContain("warn");
  });
});

describe("HealthPage exposure pointer", () => {
  test("offers a way to the 安全 page for exposure follow-up", async () => {
    // The exposure card moved to 安全; 体检 keeps only a pointer to it.
    healthMock.mockResolvedValue(healthReport());

    const { onOpen } = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "去安全页" }));

    expect(onOpen).toHaveBeenCalledWith("security");
  });
});
