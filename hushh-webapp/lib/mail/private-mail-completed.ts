/**
 * "Recently completed" for a private mailbox.
 *
 * A private agent keeps the mailbox and the model on its own runtime, so the shared
 * hub cannot list what was sent. Completion is what One itself settled for this one
 * mailbox, read from the owner's Tasks and scheduled follow-ups:
 *
 *  - a follow-up that was sent on a schedule, linked to the sent email; and
 *  - a promised reply or document that arrived and settled its Task, linked to
 *    the email that settled it.
 *
 * Nothing here is guessed. A row exists only where a Task or a scheduled send says
 * it happened, and each row opens the exact message through its opaque source id.
 * A Task of another mailbox is never a candidate, whatever its title says.
 */

import type { CompletedItem } from "@/lib/mail/mail-brief-client";
import type { ScheduledTask } from "@/lib/services/pod-scheduled-tasks";
import type { TodoItem } from "@/lib/todos/todo-list-model";

const DAY_MS = 86_400_000;
/** The same look-back the shared Overview uses for confirmed sends. */
export const COMPLETED_WINDOW_DAYS = 30;
export const COMPLETED_LIMIT = 5;
const SOURCE_ID = /^ms1\.[A-Za-z0-9_-]{16,2044}$/;

function firstName(label: string): string {
  const head = (label.split(/[,<]/)[0] ?? "").trim().split(/\s+/)[0] ?? "";
  return head;
}

export function privateCompletedItems(
  tasks: readonly TodoItem[],
  mailbox: { account: string; connection: string },
  schedules: readonly ScheduledTask[] | undefined,
  now: number = Date.now(),
): CompletedItem[] {
  const since = now - COMPLETED_WINDOW_DAYS * DAY_MS;
  const items: CompletedItem[] = [];
  for (const task of tasks) {
    const follow = task.mailFollowup;
    if (
      !follow ||
      task.status === "deleted" ||
      follow.account !== mailbox.account ||
      follow.connection !== mailbox.connection
    )
      continue;

    const scheduled = follow.scheduleId ? schedules?.find((row) => row.id === follow.scheduleId) : undefined;
    const sent = scheduled?.last_run;
    if (sent && sent.state === "completed" && sent.sent_source && SOURCE_ID.test(sent.sent_source)) {
      const at = (sent.finished_at ?? sent.started_at) * 1000;
      if (at > since && at <= now) {
        const who = firstName(follow.participant);
        items.push({
          id: `done_send_${task.id}`,
          title: who ? `Follow-up sent to ${who}` : "Follow-up sent",
          line: follow.fulfilment,
          sentAt: new Date(at).toISOString(),
          to: follow.participant,
          sourceId: sent.sent_source,
        });
      }
    }

    if (task.status === "done" && task.completedAt) {
      const at = Date.parse(task.completedAt);
      const source = follow.received?.source ?? follow.source;
      if (Number.isFinite(at) && at > since && at <= now && SOURCE_ID.test(source)) {
        items.push({
          id: `done_task_${task.id}`,
          title: task.title,
          line: follow.received?.filename
            ? `Received ${follow.received.filename}`
            : follow.received
              ? "The expected reply arrived."
              : null,
          sentAt: new Date(at).toISOString(),
          to: follow.participant,
          sourceId: source,
          viewLabel: "View email",
        });
      }
    }
  }
  return items.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt)).slice(0, COMPLETED_LIMIT);
}
