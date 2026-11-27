import { describe, expect, it } from "vitest";

import { privateCompletedItems } from "@/lib/mail/private-mail-completed";
import type { ScheduledTask } from "@/lib/services/pod-scheduled-tasks";
import type { TodoItem } from "@/lib/todos/todo-list-model";

const sid = (name: string) => `ms1.${name.padEnd(24, "x")}`;
const NOW = Date.parse("2026-11-27T10:00:00Z");
const mine = { account: "acct-a", connection: "conn-a" };
let n = 0;
function task(over: { status?: TodoItem["status"]; completedAt?: string | null; follow?: Record<string, unknown>; title?: string } = {}): TodoItem {
  n += 1;
  return {
    id: `t${n}`, title: over.title ?? "Get the signed document", status: over.status ?? "done", completedAt: "completedAt" in over ? over.completedAt : "2026-11-25T08:00:00Z",
    mailFollowup: { ...mine, source: sid("source"), participant: "Priya Shah", fulfilment: "The signed document", received: { source: sid("reply"), filename: "signed.pdf" }, ...over.follow },
  } as unknown as TodoItem;
}
const sent = (id: string, over: Partial<NonNullable<ScheduledTask["last_run"]>> = {}): ScheduledTask => ({
  id, title: "Follow-up", capability: "agent_email.send_followup.v1", revision: 1, state: "completed", repeat: "once", timezone: "UTC", next_run_at: 1, authorization_expires_at: 1,
  last_run: { state: "completed", started_at: Date.parse("2026-11-26T09:00:00Z") / 1000, finished_at: Date.parse("2026-11-26T09:01:00Z") / 1000, sent_source: sid("sent"), ...over },
});

describe("Recently completed for a private mailbox", () => {
  it("lists a settled Task with the email that settled it, and never another mailbox's Task whatever its title says", () => {
    const rows = [task({ follow: { account: "acct-b" } }), task({ follow: { connection: "conn-b" } }), task()];
    const items = privateCompletedItems(rows, mine, undefined, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Get the signed document", line: "Received signed.pdf", sourceId: sid("reply"), viewLabel: "View email" });
  });

  it("lists a follow-up only when its scheduled send completed and the sent email is known", () => {
    const pending = task({ status: "pending", completedAt: null, follow: { scheduleId: "schedule_" + "a".repeat(32), received: undefined } });
    const id = pending.mailFollowup!.scheduleId!;
    const [item] = privateCompletedItems([pending], mine, [sent(id)], NOW);
    expect(item).toMatchObject({ title: "Follow-up sent to Priya", sourceId: sid("sent") });
    expect(item?.viewLabel).toBeUndefined();
    expect(privateCompletedItems([pending], mine, [sent(id, { state: "failed" })], NOW)).toEqual([]);
    expect(privateCompletedItems([pending], mine, [sent(id, { sent_source: undefined })], NOW)).toEqual([]);
    expect(privateCompletedItems([pending], mine, undefined, NOW)).toEqual([]);
  });
});
