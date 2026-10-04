/** The reviewed compose fields supplied by an open_mail_draft client step. */
export type OpenMailDraftStep = {
  to: string;
  toName: string;
  subject: string;
  body: string;
};

const MAX_TO_CHARS = 320;
const MAX_NAME_CHARS = 200;
const MAX_SUBJECT_CHARS = 256;
const MAX_BODY_CHARS = 4000;
const EMAIL_RE = /^[^\s@<>,;\x00-\x1f\x7f]+@[^\s@<>,;\x00-\x1f\x7f]+\.[^\s@<>,;\x00-\x1f\x7f]+$/;

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
 */
export function parseOpenMailDraftStepPayload(payload: unknown): OpenMailDraftStep | null {
  const draft = record(record(payload)?.draft);
  if (!draft || Object.keys(draft).some((key) => !["to", "to_name", "subject", "body"].includes(key))) {
    return null;
  }
  const { to, to_name: toName, subject, body } = draft;
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
  return { to, toName, subject, body };
}
