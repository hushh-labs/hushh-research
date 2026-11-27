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

const sealedMailSource = z.string().regex(/^ms1\.[A-Za-z0-9_-]{16,2044}$/);
const briefEvidence = z.object({
  source_id: sealedMailSource,
  from: z.string(),
  on: z.string(),
  quote: z.string(),
});
const briefItem = z.object({
  id: z.string(),
  title: z.string(),
  evidence: z.array(briefEvidence).min(1).max(3),
});
export const privateTopicsSchema = z.array(z.object({
  id: z.string(),
  name: z.string().min(1).max(44),
  reason: z.string().min(1).max(140),
  evidence: z.array(briefEvidence).min(2).max(3),
})).max(5);
export type PrivateMailTopic = z.infer<typeof privateTopicsSchema>[number];
const overviewBrief = z.object({
  attention: z.array(briefItem.extend({ reason: z.string() })).max(8),
  updates: z.array(briefItem.extend({ line: z.string() })).max(5),
  topics: privateTopicsSchema,
});
const thread = z.object({
  truncated: z.boolean(),
  items: z.array(z.object({
    source: sealedMailSource,
    subject: z.string(),
    sender: z.string(),
    received_at: z.string().nullish(),
    body: z.string(),
    body_truncated: z.boolean(),
  })).min(1).max(20),
});
export type PrivateOverviewBrief = z.infer<typeof overviewBrief>;
export type PrivateOverviewThread = z.infer<typeof thread>;
export type PrivateOverviewRows = z.infer<typeof sourceListSchema>["items"];
type MailSelection = { account: string; connection: string };

function mailFollowupsClient() {
  async function read<T>(
    path: string,
    body: object,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const init = {
      method: "POST",
      cache: "no-store" as const,
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    const response = await ApiService.ownerPodRequest(
      "gmail/followups/" + path,
      init,
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
  const selection = ({ account, connection }: MailSelection) => ({
    account,
    connection,
  });
  return {
    account: (account: string, connection: string, signal: AbortSignal) =>
      read("account", { account, connection }, mailboxSchema, signal),
    brief: (box: MailSelection, signal: AbortSignal) =>
      read("brief", selection(box), overviewBrief, signal),
    recent: (box: MailSelection, signal: AbortSignal) =>
      read("recent", selection(box), sourceListSchema, signal),
    searchOverview: (box: MailSelection, query: string, signal: AbortSignal) =>
      read("overview-search", { ...selection(box), query }, sourceListSchema, signal),
    thread: (box: MailSelection, source: string, signal: AbortSignal) =>
      read("thread", { ...selection(box), source }, thread, signal),
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
      box: MailSelection,
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
      trackedQuotes: string[] = [],
    ) =>
      read(
        "track",
        {
          ...selection(box),
          source,
          expectation,
          tracked_quotes: trackedQuotes,
        },
        followupSchema,
        signal,
      ),
  };
}
export const MailFollowupsService = mailFollowupsClient();

const replyProposalId = z.string().regex(/^gmod_[A-Za-z0-9_-]{16,64}$/);
const replyPreview = z.object({
  to: z.tuple([z.string().email()]),
  cc: z.array(z.string()).length(0),
  bcc: z.array(z.string()).length(0),
  subject: z.string(),
  body: z.string(),
});
const preparedReply = z.object({
  status: z.literal("confirmation_required"),
  proposal_id: replyProposalId,
  expires_at: z.string(),
  preview: replyPreview,
});
export type PreparedMailReply = z.infer<typeof preparedReply>;

async function replyRequest<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: object) {
  signal.throwIfAborted();
  const response = await ApiService.ownerPodRequest(path, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    signal,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  }, false, undefined, undefined, () => !signal.aborted);
  if (!response.ok) throw new Error("Mail could not verify this reply.");
  const value = schema.parse(await response.json());
  signal.throwIfAborted();
  return value;
}

export const PrivateMailReplyService = {
  prepare: (box: MailSelection, source: string, body: string, signal: AbortSignal) =>
    replyRequest("actions/gmail/proposals", preparedReply, signal, {
      action: "send_email",
      reply: { account: box.account, connection: box.connection, source: sealedMailSource.parse(source) },
      draft: { body },
    }),
  send: async (id: string, signal: AbortSignal) => {
    const result = await replyRequest(
      `actions/${replyProposalId.parse(id)}/confirm`,
      z.object({
        proposalId: replyProposalId,
        kind: z.literal("gmail_mailbox"),
        result: z.object({ status: z.literal("sent") }),
      }),
      signal, {},
    );
    if (result.proposalId !== id) throw new Error("Mail returned a different reply.");
  },
  status: async (id: string, signal: AbortSignal) => {
    const result = await replyRequest(
      `actions/${replyProposalId.parse(id)}/status`,
      z.object({
        proposalId: replyProposalId,
        kind: z.literal("gmail_mailbox"),
        state: z.enum(["prepared", "sent", "expired", "outcome_unknown"]),
      }),
      signal,
    );
    if (result.proposalId !== id) throw new Error("Mail returned a different reply.");
    return result.state;
  },
};
