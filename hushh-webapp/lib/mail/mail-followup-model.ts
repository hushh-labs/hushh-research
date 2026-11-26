import { z } from "zod";
import type { TodoItem } from "@/lib/todos/todo-list-model";

const identity = z.string().min(1).max(256);
const source = z.string().regex(/^ms1\.[A-Za-z0-9_-]{16,2044}$/);
export const mailboxSchema = z.object({
  account: identity,
  connection: identity,
  address: z.string().email(),
});
export type FollowupMailbox = z.infer<typeof mailboxSchema>;
export const followupSchema = mailboxSchema.omit({ address: true }).extend({
  source_kind: z.literal("mail_thread"),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  thread: source,
  source,
  title: z.string().min(1).max(160),
  reason: z.string().min(1).max(220).optional(),
  participant: z.string().min(1).max(160),
  debtor: z.string().email(),
  waiting_on: z.enum(["owner", "participant"]),
  fulfilment: z.string().min(1).max(240),
  quote: z.string().min(3).max(500),
  promised_wording: z.string().max(80).nullable(),
  document: z.string().max(160).nullable(),
  received: z
    .object({ source, filename: z.string().max(255).nullable() })
    .optional(),
  scheduleId: z
    .string()
    .regex(/^schedule_[a-f0-9]{32}$/)
    .optional(),
  watching: z.boolean().optional(),
  reviewed: z.boolean().optional(),
  draft: z
    .object({
      to: z.string().email(),
      subject: z.string().max(998),
      body: z.string().max(12000),
    })
    .optional(),
});
export type MailFollowup = z.infer<typeof followupSchema>;
export const sourceListSchema = z.object({
  items: z
    .array(
      z.object({
        source,
        subject: z.string(),
        sender: z.string(),
      }),
    )
    .max(12),
});
export const evidenceSchema = z.object({
  subject: z.string(),
  sender: z.string(),
  body: z.string(),
  body_truncated: z.boolean(),
  files: z.array(z.string()),
});

export function mailboxTasks(
  tasks: readonly TodoItem[],
  mailboxes: readonly FollowupMailbox[],
) {
  return tasks.flatMap((task) => {
    const item = task.mailFollowup;
    if (
      !item ||
      task.status === "deleted" ||
      task.sourceAgent !== "gmail" ||
      !mailboxes.some(
        (box) =>
          box.account === item.account && box.connection === item.connection,
      )
    )
      return [];
    const column =
      task.status === "done"
        ? "Done"
        : item.waiting_on === "owner"
          ? "To Do"
          : "In Progress";
    return [{ task, item, column } as const];
  });
}
