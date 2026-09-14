import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TodosPage } from "./TodosPage";
import type { TodoBoard } from "../api";

const { todosMock } = vi.hoisted(() => ({ todosMock: vi.fn() }));

vi.mock("../api", () => ({ api: { todos: todosMock } }));

const board = (over: Partial<TodoBoard> = {}): TodoBoard => ({
  todos: [
    { id: "1", title: "定位日志时间戳", status: "completed" },
    { id: "2", title: "实现修复", status: "in_progress" },
    { id: "3", title: "补测试", status: "pending" },
  ],
  counts: { total: 3, pending: 1, in_progress: 1, completed: 1 },
  stale: false,
  updated_at: new Date().toISOString(),
  last_progress: null,
  idle_ms: 0,
  ...over,
});

afterEach(() => {
  cleanup();
  todosMock.mockReset();
});

describe("TodosPage", () => {
  test("renders the plan as a checklist, not just a count", async () => {
    // The whole point of the page: 会话 already showed `3`, which never told
    // the operator what the agent was actually doing.
    todosMock.mockResolvedValue(board());
    const { container } = render(<TodosPage />);
    expect(await screen.findByText("定位日志时间戳")).toBeTruthy();
    // Scoped to the list: the in-progress title also appears in the 正在做
    // callout above it, so a bare getByText would match two nodes.
    const titles = [...container.querySelectorAll(".todo-list .todo-title")].map(node => node.textContent);
    expect(titles).toEqual(["定位日志时间戳", "实现修复", "补测试"]);
    expect(screen.getByText("1/3")).toBeTruthy();
  });

  test("the in-progress item is called out as what is happening right now", async () => {
    todosMock.mockResolvedValue(board());
    const { container } = render(<TodosPage />);
    await screen.findByText("定位日志时间戳");
    // Deliberate duplication: the running item is named once in the callout and
    // once in the list, because the callout answers "what now" at a glance.
    expect(container.querySelector(".todo-current")?.textContent).toContain("实现修复");
    // Status drives the row class, which is what the stylesheet colours on.
    expect(container.querySelector(".todo-row.in_progress")).toBeTruthy();
    expect(container.querySelector(".todo-row.completed")).toBeTruthy();
  });

  test("progress is reported as a real percentage of the list", async () => {
    todosMock.mockResolvedValue(board({
      todos: [
        { id: "1", title: "a", status: "completed" },
        { id: "2", title: "b", status: "completed" },
        { id: "3", title: "c", status: "completed" },
        { id: "4", title: "d", status: "pending" },
      ],
      counts: { total: 4, pending: 1, in_progress: 0, completed: 3 },
    }));
    const { container } = render(<TodosPage />);
    await screen.findByText("3/4");
    expect(screen.getByText("已完成 75%")).toBeTruthy();
    expect((container.querySelector(".todo-bar-fill") as HTMLElement | null)?.style.width).toBe("75%");
  });

  test("a list nobody is driving is labelled, so it cannot read as live progress", async () => {
    todosMock.mockResolvedValue(board({ stale: true, idle_ms: null }));
    render(<TodosPage />);
    expect(await screen.findByText("已离线")).toBeTruthy();
  });

  test("a progress line from a departed agent is labelled and dimmed, not passed off as now", async () => {
    // The bug this pins: a fresh 任务 list (badged 实时) sat above a 23-hour-old
    // 最新进展 left by the PREVIOUS agent. The list and the progress line are
    // written by different tools and age independently, so one badge cannot
    // cover both — the timestamp alone read as "the AI is doing this".
    todosMock.mockResolvedValue(board({
      stale: false,
      progress_stale: true,
      last_progress: {
        message: "高危子集已提交；开始小合并候选逐条验证",
        phase: "running",
        at: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
      },
    }));
    const { container } = render(<TodosPage />);

    expect(await screen.findByText("上次进展")).toBeTruthy();
    // 最新 would be a lie about a line nobody has sent since yesterday.
    expect(screen.queryByText("最新进展")).toBeNull();
    expect(screen.getAllByText("已离线").length).toBe(1);
    // Dimmed as well as badged: the chip is easy to miss above a sentence that
    // reads like a live status line.
    expect(container.querySelector(".todo-progress-msg")?.className).toContain("muted");
  });

  test("a progress line from the session that is still here stays 最新", async () => {
    todosMock.mockResolvedValue(board({
      progress_stale: false,
      last_progress: { message: "正在跑 verify", at: new Date().toISOString() },
    }));
    const { container } = render(<TodosPage />);

    expect(await screen.findByText("最新进展")).toBeTruthy();
    expect(screen.queryByText("已离线")).toBeNull();
    expect(container.querySelector(".todo-progress-msg")?.className).not.toContain("muted");
  });

  test("an empty list explains how something would get here", async () => {
    todosMock.mockResolvedValue(board({
      todos: [],
      counts: { total: 0, pending: 0, in_progress: 0, completed: 0 },
    }));
    render(<TodosPage />);
    expect(await screen.findByText("还没有任务")).toBeTruthy();
    expect(screen.getByText("set_todos")).toBeTruthy();
  });

  test("the last report_progress line is shown when there is one", async () => {
    todosMock.mockResolvedValue(board({
      last_progress: { message: "正在重建 dist", phase: "build", at: new Date().toISOString() },
    }));
    render(<TodosPage />);
    expect(await screen.findByText("正在重建 dist")).toBeTruthy();
  });
});
