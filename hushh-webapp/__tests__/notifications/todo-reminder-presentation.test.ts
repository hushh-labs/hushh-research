import { expect, it, vi } from "vitest";
import { presentTodoReminder } from "@/lib/notifications/todo-reminder-presentation";

it("presents owner reminders once and rejects expired, hidden and wrong-owner deliveries", () => {
  const data = { user_id: "owner", message_id: "reminder-one", reminder_expires_at: "1000" };
  const input = { ownerId: "owner", visible: true, active: true, seen: new Set<string>(), now: 100, present: vi.fn() };
  expect(presentTodoReminder({ ...data, user_id: "previous-owner" }, input)).toBe(false);
  expect(presentTodoReminder({ ...data, reminder_expires_at: "0" }, input)).toBe(false);
  expect(presentTodoReminder(data, { ...input, visible: false })).toBe(false);
  expect(presentTodoReminder(data, { ...input, active: false })).toBe(false);
  expect(presentTodoReminder(data, input)).toBe(true);
  expect(presentTodoReminder(data, input)).toBe(true);
  expect(input.present).toHaveBeenCalledOnce();
});
