import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SkillsPage } from "./SkillsPage";
import type { SkillCatalog } from "../api";

const { skillsMock } = vi.hoisted(() => ({ skillsMock: vi.fn() }));
vi.mock("../api", () => ({ api: { skills: skillsMock } }));

const CATALOG: SkillCatalog = {
  count: 2,
  skills: [
    { name: "anysearch", description: "网络检索", path: "C:/w/skills/anysearch/SKILL.md", dir: "C:/w/skills/anysearch", outside_workspace: false },
    { name: "deploy", description: "发布流程", path: "C:/data/skills/deploy/SKILL.md", dir: "C:/data/skills/deploy", outside_workspace: true },
  ],
};

afterEach(() => { cleanup(); skillsMock.mockReset(); });

describe("SkillsPage", () => {
  test("lists discovered skills with source directory and workspace marker", async () => {
    skillsMock.mockResolvedValue(CATALOG);
    render(<SkillsPage />);

    expect(await screen.findByText("anysearch")).toBeTruthy();
    expect(screen.getByText("deploy")).toBeTruthy();
    expect(screen.getByText("C:/data/skills/deploy")).toBeTruthy();
    expect(screen.getByText("工作区外")).toBeTruthy();
    expect(screen.getByText("共 2 个技能")).toBeTruthy();
  });

  test("the filter narrows by name or description", async () => {
    skillsMock.mockResolvedValue(CATALOG);
    render(<SkillsPage />);
    await screen.findByText("anysearch");

    fireEvent.change(screen.getByLabelText("过滤技能"), { target: { value: "发布" } });
    expect(screen.queryByText("anysearch")).toBeNull();
    expect(screen.getByText("deploy")).toBeTruthy();
    expect(screen.getByText("显示 1 个")).toBeTruthy();
  });

  test("an empty library explains how skills are discovered", async () => {
    skillsMock.mockResolvedValue({ count: 0, skills: [] });
    render(<SkillsPage />);

    expect(await screen.findByText("还没有发现任何技能。")).toBeTruthy();
    expect(screen.getByText(/SKILL\.md/)).toBeTruthy();
  });

  test("a failed load surfaces the error instead of an empty table", async () => {
    skillsMock.mockRejectedValueOnce(new Error("boom"));
    const { container } = render(<SkillsPage />);
    await screen.findByText("boom");
    expect(container.querySelector(".skeleton")).toBeNull();
  });
});
