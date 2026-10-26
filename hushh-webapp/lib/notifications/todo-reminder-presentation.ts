import { notificationEventDedupKey } from "./notification-event-identity";

/** The caller owns authentication, lifecycle, per-owner replay state and toast UI. */
export function presentTodoReminder(data: Record<string, string>, input: {
  ownerId: string | null; visible: boolean; active: boolean;
  seen: Set<string>; now: number; present: () => void;
}): boolean {
  if (!input.visible || !input.active) return false;
  const expires = Number(data.reminder_expires_at);
  if (!input.ownerId || data.user_id !== input.ownerId || !data.message_id ||
    !Number.isFinite(expires) || expires * 1000 <= input.now) return false;
  const key = notificationEventDedupKey("todo_reminder", data);
  if (!key) return false;
  if (input.seen.has(key)) return true;
  input.present();
  input.seen.add(key);
  while (input.seen.size > 1000) {
    const oldest = input.seen.values().next().value;
    if (!oldest) break;
    input.seen.delete(oldest);
  }
  return true;
}
