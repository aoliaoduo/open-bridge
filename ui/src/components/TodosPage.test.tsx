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
