import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { groupByDate, TodoRows, type DueReceiptItem } from "@/components/todos/todo-list-presentation";
import { TodoTaskDetail } from "@/components/todos/todo-task-detail";
import type { TodoItem } from "@/lib/services/todo-list-pkm-service";

describe("TodoRows presentation", () => {
  it("keeps malformed calendar dates undated without hiding valid rows or throwing in detail", () => {
    const task = { id: "malformed-date", title: "Malformed date task", type: "manual", status: "pending", date: "2026-13-01", time: "99:99" } as TodoItem;
    const valid = { ...task, id: "valid-date", title: "Valid task", date: "2099-01-01", time: "09:30" };
    expect(groupByDate([task, valid]).map(group => ({ id: group.id, count: group.tasks.length }))).toEqual([
      { id: "anytime", count: 1 }, { id: "2099-01-01", count: 1 },
    ]);
    const detail = render(<TodoTaskDetail task={task} busy={false} onBack={vi.fn()} onToggle={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole("heading", { name: task.title })).toBeVisible();
    detail.unmount();
    render(<TodoRows tasks={[task, valid]} dueReceipts={[]} savingTaskIds={new Set()} onToggle={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(task.title)).toBeVisible();
    expect(screen.getByText(valid.title)).toBeVisible();
    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
  });

  it("orders Any time tasks first, due receipts in the middle, and dated tasks below", () => {
    const tasks: TodoItem[] = [
      {
        id: "dated-1",
        title: "Tomorrow task",
        date: "2099-01-01",
        status: "pending",
        type: "manual",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "anytime-1",
        title: "Anytime task",
        date: null,
        status: "pending",
        type: "manual",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const dueReceipts: DueReceiptItem[] = [
      {
        id: "rec-1",
        merchantName: "Acme Cloud",
        title: "Monthly hosting",
        amount: "$49.00",
        date: "Oct 18",
        status: "overdue",
        statusLabel: "Payment overdue",
        href: "/one/gmail?workspace=receipts",
      },
    ];

    const { container } = render(
      <TodoRows
        tasks={tasks}
        dueReceipts={dueReceipts}
        savingTaskIds={new Set()}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const sections = container.querySelectorAll("section");
    expect(sections).toHaveLength(3);

    expect(sections[0]).toHaveTextContent("Any time");
    expect(sections[0]).toHaveTextContent("Anytime task");

    expect(sections[1]).toHaveTextContent("Receipts & Due Payments");
    expect(sections[1]).toHaveTextContent("Acme Cloud");
    expect(sections[1]).toHaveTextContent("$49.00");

    expect(sections[2]).toHaveTextContent("Tomorrow task");
  });
});
