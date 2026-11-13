import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TodoRows, type DueReceiptItem } from "@/components/todos/todo-list-presentation";
import type { TodoItem } from "@/lib/services/todo-list-pkm-service";

describe("TodoRows presentation", () => {
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
        savingTaskId={null}
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

  it("keeps Open and Join actions compact on mobile while restoring the touch-safe desktop size", () => {
    const task: TodoItem = {
      id: "calendar-1",
      title: "Demo call",
      date: "2099-01-01",
      status: "pending",
      type: "calendar",
      sourceAgent: "calendar",
      link: "https://calendar.google.com/event/demo",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const { getByRole } = render(
      <TodoRows
        tasks={[task]}
        savingTaskId={null}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const action = getByRole("link", { name: "Join Demo call" });
    expect(action).toHaveClass("max-sm:!h-9");
    expect(action).toHaveClass("max-sm:!min-h-9");
    expect(action).toHaveClass("max-sm:!px-1.5");
    expect(action).toHaveClass("min-h-11");
  });
});
