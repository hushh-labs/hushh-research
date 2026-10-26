import type { TodoItem } from "./todo-list-model";

export function todoReminderLocalFields(instant: string) {
  const value = new Date(instant);
  const pad = (part: number) => String(part).padStart(2, "0");
  return { date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}` };
}

/** Resolve once in the editor's time zone; never move a saved instant on another device. */
export function todoReminderInstant(date: string | null, time: string | null): string | null {
  if (!time) return null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Invalid reminder time");
  const instant = new Date(`${date}T${time}:00`);
  const local = `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, "0")}-${String(instant.getDate()).padStart(2, "0")}`;
  if (!Number.isFinite(instant.getTime()) || local !== date || instant.getHours() !== Number(time.slice(0, 2)) || instant.getMinutes() !== Number(time.slice(3))) throw new Error("Invalid local reminder time");
  for (const offset of [30, 60, 90, 120, 180]) {
    for (const direction of [-1, 1]) {
      const other = new Date(instant.getTime() + direction * offset * 60_000);
      if (other.toDateString() === instant.toDateString() && other.getHours() === instant.getHours() && other.getMinutes() === instant.getMinutes()) throw new Error("Ambiguous local reminder time");
    }
  }
  return instant.toISOString();
}

/** Only opaque routing metadata leaves encrypted task storage. */
export async function todoReminderProjection(userId: string, tasks: TodoItem[]) {
  const items = await Promise.all(tasks.filter(task => task.status === "pending" && task.reminderAt).map(async task => {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`todo-reminder-v1\0${userId}\0${task.id}`)));
    hash[6] = (hash[6]! & 15) | 80;
    hash[8] = (hash[8]! & 63) | 128;
    const value = Array.from(hash.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
    const taskRef = `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    return { task_ref: taskRef, due_at: task.reminderAt! };
  }));
  return { projectionType: "todo_reminders_v1", projectionVersion: 1, payload: { items } };
}
