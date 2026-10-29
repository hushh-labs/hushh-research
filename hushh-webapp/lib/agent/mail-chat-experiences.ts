/**
 * Mail cards One's chat renders from its own live results: the Email
 * specialist's mail brief and the receipt setup hint. Both are owner-screen
 * only. Durable chat history redacts the results they come from, so a
 * restored chat shows neither card.
 */
import {
  WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE,
  type WorkspaceConnectorSetupExperience,
} from "./connector-read-receipt";

export const MAIL_BRIEF_EXPERIENCE_TYPE = "one.mail_brief.v1" as const;
export const RECEIPT_SETUP_EXPERIENCE_TYPE = "one.receipt_setup.v1" as const;

export const MAIL_BRIEF_CATEGORIES = [
  "action_items",
  "personal_info",
  "payments_due",
  "security_alerts",
  "meetings",
] as const;
export type MailBriefCategory = (typeof MAIL_BRIEF_CATEGORIES)[number];
const STATES = ["active", "completed", "cancelled", "rescheduled", "unclear"] as const;
export type MailBriefState = (typeof STATES)[number];

export type MailBriefItem = {
  sourceRef: string;
  category: MailBriefCategory;
  senderName: string | null;
  subject: string | null;
  detail: string | null;
  state: MailBriefState;
  receivedAt: string | null;
  dueAt: string | null;
  eventAt: string | null;
};

export type MailBriefExperience = {
  type: typeof MAIL_BRIEF_EXPERIENCE_TYPE;
  checkedAt: string;
  requested: MailBriefCategory[];
  failed: MailBriefCategory[];
  items: MailBriefItem[];
  moreMailOutsidePage: boolean;
  someUnreadable: boolean;
  textShortened: boolean;
};

export type ReceiptSetupExperience = {
  type: typeof RECEIPT_SETUP_EXPERIENCE_TYPE;
  state: "sync_required";
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

function text(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= limit ? value.trim() : null;
}

function category(value: unknown): MailBriefCategory | null {
  return MAIL_BRIEF_CATEGORIES.find((name) => name === value) ?? null;
}

/** A list of known categories; one unknown name rejects the whole list. */
function categories(value: unknown): MailBriefCategory[] | null {
  if (!Array.isArray(value)) return null;
  const names = value.map(category);
  return names.every((name) => name !== null) ? names : null;
}

function briefItem(value: unknown): MailBriefItem | null {
  const item = record(value);
  const kind = category(item?.category);
  const state = STATES.find((name) => name === item?.state);
  const sourceRef = text(item?.source_ref, 32);
  if (!item || !kind || !state || !sourceRef) return null;
  return {
    sourceRef,
    category: kind,
    senderName: text(item.sender_name, 160),
    subject: text(item.subject, 320),
    detail: text(item.detail, 280),
    state,
    receivedAt: text(item.received_at, 40),
    dueAt: text(item.due_at, 40),
    eventAt: text(item.event_at, 40),
  };
}

/**
 * The card under a receipt answer the device could not compute: the existing
 * in-chat Connect card when Gmail is not connected, else the sync hint.
 */
export function receiptSetupExperience(
  state: "connect_required" | "sync_required",
): WorkspaceConnectorSetupExperience | ReceiptSetupExperience {
  return state === "connect_required"
    ? { type: WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE, provider: "gmail", status: "connect_required" }
    : { type: RECEIPT_SETUP_EXPERIENCE_TYPE, state: "sync_required" };
}

/** The bounded brief card from an ask_email_agent result, or null. */
export function parseMailBriefExperience(result: Json | null): MailBriefExperience | null {
  const brief = record(result?.mail_brief);
  if (brief?.schema_version !== "mail_brief.v1" || !Array.isArray(brief.items)) return null;
  const checkedAt = text(brief.checked_at, 40);
  const rawCounts = record(brief.counts_by_category);
  const requested = categories(brief.requested);
  const failed = categories(brief.failed);
  const coverage = record(brief.coverage);
  if (!checkedAt || !rawCounts || !requested?.length || !failed || !coverage || brief.items.length > 60) return null;
  // A failed kind was always requested, and some requested kind finished; anything else can't be summarized truthfully.
  if (failed.some((name) => !requested.includes(name)) || requested.every((name) => failed.includes(name))) return null;
  const counts: Partial<Record<MailBriefCategory, number>> = {};
  for (const [name, count] of Object.entries(rawCounts)) {
    const kind = category(name);
    if (!kind || !Number.isInteger(count) || (count as number) < 0) return null;
    counts[kind] = count as number;
  }
  const items = brief.items.map(briefItem).filter((item) => item !== null);
  // The card counts open items, so the items must carry every finding the server counted.
  const mismatched = (name: MailBriefCategory) =>
    items.filter((item) => item.category === name).length !== (counts[name] ?? 0);
  if (MAIL_BRIEF_CATEGORIES.some(mismatched)) return null;
  return {
    type: MAIL_BRIEF_EXPERIENCE_TYPE,
    checkedAt,
    requested,
    failed,
    items,
    moreMailOutsidePage: coverage.more_mail_outside_page === true,
    someUnreadable: typeof coverage.unreadable === "number" && coverage.unreadable > 0,
    textShortened: coverage.text_shortened === true,
  };
}
