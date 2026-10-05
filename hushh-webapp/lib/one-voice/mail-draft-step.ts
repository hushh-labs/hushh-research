/** The reviewed compose fields supplied by an open_mail_draft client step. */
export type OpenMailDraftStep = {
  to: string;
  toName: string;
  subject: string;
  body: string;
  /**
   * `reply` answers an email in its own Gmail thread: To and Subject were
   * derived by the server from that email and stay locked on the card.
   */
  mode: "compose" | "reply";
  /** Opaque server binding to the email a reply answers; null for compose. */
  sourceMailRef: string | null;
};

const MAX_TO_CHARS = 320;
const MAX_NAME_CHARS = 200;
const MAX_SUBJECT_CHARS = 256;
const MAX_BODY_CHARS = 4000;
const EMAIL_RE = /^[^\s@<>,;\x00-\x1f\x7f]+@[^\s@<>,;\x00-\x1f\x7f]+\.[^\s@<>,;\x00-\x1f\x7f]+$/;
/** The server's sealed reference shape; the browser can carry it, never open it. */
const SOURCE_MAIL_REF_RE = /^rs1\.[A-Za-z0-9_-]{16,2044}$/;
/** Session-issued correlation for a review card's Send report. */
const DELIVERY_REF_RE = /^[A-Za-z0-9_-]{16,64}$/;
const COMPOSE_KEYS = ["to", "to_name", "subject", "body"];
const REPLY_KEYS = [...COMPOSE_KEYS, "mode", "source_mail_ref"];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function within(value: string, max: number): boolean {
  // Python's schema counts Unicode code points, so use the same bound here.
  return Array.from(value).length <= max;
}

/**
 * Accept only a single, complete server-derived envelope. Invalid fields fail
 * the client step; none are truncated, guessed, or used to start a send.
 *
 * A reply's binding travels inside `draft` on purpose: a client that predates
 * replies rejects the unknown keys and fails the step, instead of opening an
 * ordinary compose card whose Send would go out as a new, unthreaded email.
 */
export function parseOpenMailDraftStepPayload(payload: unknown): OpenMailDraftStep | null {
  const draft = record(record(payload)?.draft);
  if (!draft) return null;
  const reply = draft.mode === "reply";
  if (draft.mode !== undefined && !reply) return null;
  const allowed = reply ? REPLY_KEYS : COMPOSE_KEYS;
  if (Object.keys(draft).some((key) => !allowed.includes(key))) return null;
  const { to, to_name: toName, subject, body, source_mail_ref: sourceMailRef } = draft;
  if (
    typeof to !== "string" ||
    !within(to, MAX_TO_CHARS) ||
    to !== to.trim() ||
    !EMAIL_RE.test(to) ||
    typeof toName !== "string" ||
    !toName.trim() ||
    !within(toName, MAX_NAME_CHARS) ||
    /[\x00-\x1f\x7f]/.test(toName) ||
    typeof subject !== "string" ||
    !within(subject, MAX_SUBJECT_CHARS) ||
    /[\r\n]/.test(subject) ||
    typeof body !== "string" ||
    !body.trim() ||
    !within(body, MAX_BODY_CHARS)
  ) {
    return null;
  }
  if (reply && (typeof sourceMailRef !== "string" || !SOURCE_MAIL_REF_RE.test(sourceMailRef))) {
    return null;
  }
  return {
    to,
    toName,
    subject,
    body,
    mode: reply ? "reply" : "compose",
    sourceMailRef: reply ? (sourceMailRef as string) : null,
  };
}

/**
 * The step's delivery ref, if it carried a well-formed one. Absent is fine: an
 * older relay issues none, and the card still sends; only the spoken report of
 * the Send is skipped.
 */
export function parseMailDeliveryRef(payload: unknown): string | null {
  const value = record(payload)?.delivery_ref;
  return typeof value === "string" && DELIVERY_REF_RE.test(value) ? value : null;
}
