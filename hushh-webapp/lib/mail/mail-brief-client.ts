/**
 * The Overview brief's two reads: what needs the owner and what changed
 * (`/brief`, model-assisted and server-verified), and what is confirmed done
 * (`/completed`, no model).
 *
 * Every message a card points at is an opaque `sourceId`: the same account-bound
 * identity Recent mail uses, so "Why this?", "Draft reply" and "View sent email"
 * all open the exact message in the connected mailbox and never another. Nothing
 * is defaulted into existence. A 200 that does not describe the brief is a
 * failure, never an empty brief.
 */

import {
  accountField,
  malformed,
  nullableText,
  overviewPost,
  record,
  type Auth,
} from "@/lib/mail/mail-overview-client";

/** The brief waits on a model; the server's own limit is 40 seconds. */
const BRIEF_TIMEOUT_MS = 60_000;
const SOURCE_ID = /^ms1\.[A-Za-z0-9_-]{16,2044}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type BriefEvidence = {
  sourceId: string;
  /** "You" for the owner's own message, otherwise the sender as the mail names them. */
  from: string;
  /** The day the message was sent, `YYYY-MM-DD`. */
  on: string;
  direction: "sent" | "received";
  /** Words copied from that message; the server checked they are really in it. */
  quote: string;
};

export type AttentionKind = "reply" | "follow_up";
export type DueRole = "promised" | "needed_by" | "due";

export type AttentionItem = {
  id: string;
  kind: AttentionKind;
  title: string;
  reason: string;
  context: string | null;
  /** Who it is with, from the message header. */
  person: string;
  due: { date: string; role: DueRole; label: string } | null;
  /** A term the message states exactly, e.g. "30 to 45 days". */
  term: string | null;
  action: {
    kind: "draft_reply" | "draft_followup";
    /** The message the draft is written on. */
    sourceId: string;
    /** An optional starting text. The person reviews and edits it. */
    draft: string | null;
  };
  evidence: BriefEvidence[];
};

export type UpdateKind = "approval" | "confirmation" | "change" | "received";

export type UpdateItem = {
  id: string;
  kind: UpdateKind;
  title: string;
  line: string;
  person: string;
  on: string;
  action:
    | { kind: "none"; sourceId: null; draft: null }
    | { kind: "thank"; sourceId: string; draft: string | null };
  evidence: BriefEvidence[];
};

export type MailBrief = {
  account: string;
  generatedAt: string;
  coverage: { messages: number; windowDays: number; mayBePartial: boolean };
  attention: AttentionItem[];
  updates: UpdateItem[];
};

export type CompletedItem = {
  id: string;
  title: string;
  /** Present only when the sent message itself has the attachment. */
  line: string | null;
  sentAt: string;
  to: string | null;
  /** Opens the exact message behind the row: the sent email, or the reply that arrived. */
  sourceId: string;
  /** Link text for `sourceId`. A confirmed send says "View sent email", which is the default. */
  viewLabel?: string;
};

export type MailCompleted = { account: string; items: CompletedItem[] };

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= max ? clean : null;
}

function parseEvidence(value: unknown): BriefEvidence {
  const row = record(value);
  const sourceId = typeof row?.source_id === "string" ? row.source_id : "";
  const from = text(row?.from, 160);
  const quote = text(row?.quote, 400);
  const on = typeof row?.on === "string" ? row.on : "";
  if (
    !row ||
    !SOURCE_ID.test(sourceId) ||
    !from ||
    !quote ||
    !DAY.test(on) ||
    (row.direction !== "sent" && row.direction !== "received")
  ) {
    throw malformed();
  }
  return { sourceId, from, on, direction: row.direction, quote };
}

function parseEvidenceList(value: unknown): BriefEvidence[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw malformed();
  return value.map(parseEvidence);
}

function parseAttention(value: unknown): AttentionItem {
  const item = record(value);
  const action = record(item?.action);
  const due = item?.due === null ? null : record(item?.due);
  const id = text(item?.id, 64);
  const title = text(item?.title, 120);
  const reason = text(item?.reason, 240);
  const person = text(item?.person, 160);
  const context = nullableText(item?.context);
  const term = nullableText(item?.term);
  const draft = action ? nullableText(action.draft) : undefined;
  const sourceId = typeof action?.source_id === "string" ? action.source_id : "";
  if (
    !item ||
    !id ||
    !title ||
    !reason ||
    !person ||
    (item.kind !== "reply" && item.kind !== "follow_up") ||
    context === undefined ||
    term === undefined ||
    draft === undefined ||
    !action ||
    (action.kind !== "draft_reply" && action.kind !== "draft_followup") ||
    !SOURCE_ID.test(sourceId) ||
    due === undefined
  ) {
    throw malformed();
  }
  let parsedDue: AttentionItem["due"] = null;
  if (due) {
    const label = text(due.label, 60);
    if (
      typeof due.date !== "string" ||
      !DAY.test(due.date) ||
      (due.role !== "promised" && due.role !== "needed_by" && due.role !== "due") ||
      !label
    ) {
      throw malformed();
    }
    parsedDue = { date: due.date, role: due.role, label };
  }
  return {
    id,
    kind: item.kind,
    title,
    reason,
    context,
    person,
    due: parsedDue,
    term,
    action: { kind: action.kind, sourceId, draft },
    evidence: parseEvidenceList(item.evidence),
  };
}

function parseUpdate(value: unknown): UpdateItem {
  const item = record(value);
  const action = record(item?.action);
  const id = text(item?.id, 64);
  const title = text(item?.title, 120);
  const line = text(item?.line, 240);
  const person = text(item?.person, 160);
  const on = typeof item?.on === "string" ? item.on : "";
  if (
    !item ||
    !id ||
    !title ||
    !line ||
    !person ||
    !DAY.test(on) ||
    !["approval", "confirmation", "change", "received"].includes(String(item.kind)) ||
    !action
  ) {
    throw malformed();
  }
  let parsedAction: UpdateItem["action"] = { kind: "none", sourceId: null, draft: null };
  if (action.kind === "thank") {
    const sourceId = typeof action.source_id === "string" ? action.source_id : "";
    const draft = nullableText(action.draft);
    if (!SOURCE_ID.test(sourceId) || draft === undefined) throw malformed();
    parsedAction = { kind: "thank", sourceId, draft };
  } else if (action.kind !== "none") {
    throw malformed();
  }
  return {
    id,
    kind: item.kind as UpdateKind,
    title,
    line,
    person,
    on,
    action: parsedAction,
    evidence: parseEvidenceList(item.evidence),
  };
}

function unique<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

export function parseMailBrief(body: unknown): MailBrief {
  const root = record(body);
  const coverage = record(root?.coverage);
  const account = typeof root?.account === "string" ? root.account : "";
  const generatedAt = typeof root?.generated_at === "string" ? root.generated_at : "";
  if (
    !root ||
    !account ||
    !generatedAt ||
    Number.isNaN(Date.parse(generatedAt)) ||
    !coverage ||
    typeof coverage.messages !== "number" ||
    typeof coverage.window_days !== "number" ||
    typeof coverage.may_be_partial !== "boolean" ||
    !Array.isArray(root.attention) ||
    !Array.isArray(root.updates)
  ) {
    throw malformed();
  }
  return {
    account,
    generatedAt,
    coverage: {
      messages: coverage.messages,
      windowDays: coverage.window_days,
      mayBePartial: coverage.may_be_partial,
    },
    attention: unique(root.attention.map(parseAttention)),
    updates: unique(root.updates.map(parseUpdate)),
  };
}

export function parseMailCompleted(body: unknown): MailCompleted {
  const root = record(body);
  const account = typeof root?.account === "string" ? root.account : "";
  if (!root || !account || !Array.isArray(root.items)) throw malformed();
  const items = root.items.map((value): CompletedItem => {
    const row = record(value);
    const id = text(row?.id, 64);
    const title = text(row?.title, 160);
    const line = nullableText(row?.line);
    const to = nullableText(row?.to);
    const sentAt = typeof row?.sent_at === "string" ? row.sent_at : "";
    const sourceId = typeof row?.source_id === "string" ? row.source_id : "";
    if (
      !row ||
      !id ||
      !title ||
      line === undefined ||
      to === undefined ||
      Number.isNaN(Date.parse(sentAt)) ||
      !SOURCE_ID.test(sourceId)
    ) {
      throw malformed();
    }
    return { id, title, line, to, sentAt, sourceId };
  });
  return { account, items: unique(items) };
}

/** What needs the owner and what changed. Reads mail; changes nothing. */
export async function fetchMailBrief(input: Auth): Promise<MailBrief> {
  return parseMailBrief(
    await overviewPost("/brief", { ...accountField(input) }, { ...input, timeoutMs: BRIEF_TIMEOUT_MS }),
  );
}

/** Confirmed sends only. */
export async function fetchMailCompleted(input: Auth): Promise<MailCompleted> {
  return parseMailCompleted(await overviewPost("/completed", { ...accountField(input) }, input));
}
