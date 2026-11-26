import { z } from "zod";
import { ApiService } from "./api-service";
import {
  evidenceSchema,
  followupSchema,
  mailboxSchema,
  sourceListSchema,
  type FollowupMailbox,
  type MailFollowup,
} from "@/lib/mail/mail-followup-model";

async function read<T>(
  path: string,
  body: object,
  schema: z.ZodType<T>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const response = await ApiService.ownerPodRequest(
    `gmail/followups/${path}`,
    {
      method: "POST",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    false,
    undefined,
    undefined,
    () => !signal.aborted,
  );
  if (!response.ok) {
    if (response.status === 422)
      throw new Error(
        "The selected email does not establish that promise. Choose another message or describe the request more precisely.",
      );
    throw new Error(
      "Mail could not verify this mailbox. Reopen Follow-ups and try again.",
    );
  }
  const result = schema.parse(await response.json());
  signal.throwIfAborted();
  return result;
}
const selection = ({ account, connection }: FollowupMailbox) => ({
  account,
  connection,
});
export const MailFollowupsService = {
  account: (account: string, connection: string, signal: AbortSignal) =>
    read("account", { account, connection }, mailboxSchema, signal),
  search: (box: FollowupMailbox, query: string, signal: AbortSignal) =>
    read("search", { ...selection(box), query }, sourceListSchema, signal),
  open: (box: FollowupMailbox, source: string, signal: AbortSignal) =>
    read("open", { ...selection(box), source }, evidenceSchema, signal),
  check: (box: FollowupMailbox, item: MailFollowup, signal: AbortSignal) =>
    read(
      "check",
      {
        ...selection(box),
        source: item.source,
        fulfilment: item.fulfilment,
        quote: item.quote,
        document: item.document,
        debtor: item.debtor,
      },
      z.object({
        source: z
          .string()
          .regex(/^ms1\.[A-Za-z0-9_-]{16,2044}$/)
          .nullable(),
        filename: z.string().max(255).nullable(),
      }),
      signal,
    ),
  document: (
    box: FollowupMailbox,
    source: string,
    filename: string,
    signal: AbortSignal,
  ) =>
    read(
      "document",
      { ...selection(box), source, filename },
      z.object({ content: z.string().min(1) }),
      signal,
    ),
  draft: (
    box: FollowupMailbox,
    source: string,
    expectation: string,
    signal: AbortSignal,
  ) =>
    read(
      "draft",
      { ...selection(box), source, expectation },
      z.object({
        to: z.string().email(),
        subject: z.string().max(998),
        body: z.string().max(12000),
      }),
      signal,
    ),
  track: (
    box: FollowupMailbox,
    source: string,
    expectation: string,
    signal: AbortSignal,
  ) =>
    read(
      "track",
      { ...selection(box), source, expectation },
      followupSchema,
      signal,
    ),
};
