import type { EmailDraft } from "@/lib/services/email-delivery-service";

export type GmailReviewDirective = {
  type: "gmail.review_requested";
  operation: "send_email" | "reply_to_thread";
  draft: { to: string; cc: string; bcc: string; subject: string; body: string; sourceMailRef?: string };
};

/** A prepared review is never an approval or a request for another drafting model. */
export function parseGmailReviewDirective(value: unknown): GmailReviewDirective | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !["type", "operation", "draft"].includes(key)) ||
      record.type !== "gmail.review_requested" ||
      (record.operation !== "send_email" && record.operation !== "reply_to_thread")) return null;
  if (!record.draft || typeof record.draft !== "object" || Array.isArray(record.draft)) return null;
  const draft = record.draft as Record<string, unknown>;
  if (Object.keys(draft).some(key => !["to", "cc", "bcc", "subject", "body", "sourceMailRef"].includes(key))) return null;
  for (const [key, limit] of [["to", 2048], ["cc", 2048], ["bcc", 2048], ["subject", 512], ["body", 12000]] as const) {
    if (typeof draft[key] !== "string" || draft[key].length > limit) return null;
  }
  if (!String(draft.to).trim() || !String(draft.body).trim()) return null;
  if (record.operation === "reply_to_thread") {
    if (typeof draft.sourceMailRef !== "string" || draft.sourceMailRef.length > 2048 ||
        !/^rs1\.[A-Za-z0-9_-]{16,2044}$/.test(draft.sourceMailRef) || draft.cc !== "" || draft.bcc !== "") return null;
  } else if (draft.sourceMailRef !== undefined) return null;
  return { type: record.type, operation: record.operation, draft: { to: draft.to as string,
    cc: draft.cc as string, bcc: draft.bcc as string, subject: draft.subject as string,
    body: draft.body as string, ...(typeof draft.sourceMailRef === "string" ? { sourceMailRef: draft.sourceMailRef } : {}) } };
}

/**
 * The person's unsent mail draft as it is on screen, so a follow-up turn can
 * revise it. It grants nothing: One can only open a replacement review card,
 * and sending still needs the person's Send click on that card.
 */
export type PendingEmailDraftContext = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  driveFileId?: string;
  /** Opaque server-issued source for a generic Gmail reply; request memory only. */
  sourceMailRef?: string;
  /** A reply to the selected Gmail request; its envelope stays server-derived. */
  sourceBound: boolean;
};

export function buildPendingEmailDraftContext(
  draft: EmailDraft | null,
  sourceBoundEnvelope: { to: string; subject: string } | null,
  sourceBound: boolean,
): PendingEmailDraftContext | null {
  if (!draft) return null;
  // Never downgrade a malformed or doubly bound reply into an ordinary compose
  // or a KYC reply. The sealed reference stays exact and request-scoped.
  if (draft.sourceMailRef !== undefined && (!sourceBound || draft.sourceWorkflowId ||
      typeof draft.sourceMailRef !== "string" || draft.sourceMailRef.length > 2048 ||
      !/^rs1\.[A-Za-z0-9_-]{16,2044}$/.test(draft.sourceMailRef))) return null;
  const context: PendingEmailDraftContext = {
    to: (sourceBound ? sourceBoundEnvelope?.to ?? "" : draft.to).trim(),
    cc: sourceBound ? "" : draft.cc.trim(),
    bcc: sourceBound ? "" : draft.bcc.trim(),
    subject: (sourceBound ? sourceBoundEnvelope?.subject ?? "" : draft.subject).trim(),
    body: draft.body.trim(),
    sourceBound,
  };
  if (sourceBound && draft.sourceMailRef) context.sourceMailRef = draft.sourceMailRef;
  if (!sourceBound && draft.driveFileId) context.driveFileId = draft.driveFileId;
  return context.body || context.to || context.subject ? context : null;
}
