import { describe, expect, it } from "vitest";

import { COMPLETED_LIMIT, privateCompletedItems } from "@/lib/mail/private-mail-completed";
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
  it("lists a settled Task with the email that settled it, and says what arrived", () => {
    const [item] = privateCompletedItems([task()], mine, undefined, NOW);
    expect(item).toMatchObject({ title: "Get the signed document", line: "Received signed.pdf", sourceId: sid("reply"), viewLabel: "View email", to: "Priya Shah" });
  });

  it("never lists another mailbox's Task, whatever its title says", () => {
    const rows = [task({ follow: { account: "acct-b" } }), task({ follow: { connection: "conn-b" } }), task()];
    expect(privateCompletedItems(rows, mine, undefined, NOW)).toHaveLength(1);
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

  it("drops what is older than 30 days, what was deleted, and what has no email to open", () => {
    const rows = [
      task({ completedAt: "2026-10-01T00:00:00Z" }),
      task({ status: "deleted" }),
      task({ follow: { received: undefined, source: "not-a-source" } }),
      task({ status: "pending", completedAt: null }),
    ];
    expect(privateCompletedItems(rows, mine, undefined, NOW)).toEqual([]);
  });

  it("shows the newest first and no more than the limit", () => {
    const rows = Array.from({ length: COMPLETED_LIMIT + 3 }, (_, index) => task({ title: `Task ${index}`, completedAt: new Date(NOW - (index + 1) * 3_600_000).toISOString() }));
    const items = privateCompletedItems(rows, mine, undefined, NOW);
    expect(items.map((item) => item.title)).toEqual(Array.from({ length: COMPLETED_LIMIT }, (_, index) => `Task ${index}`));
  });
});
