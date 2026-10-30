import {
  EmailDeliveryError,
  type EmailDraft,
} from "@/lib/services/email-delivery-service";

/**
 * Refusals the send route makes before it touches the prepared action: the
 * reply's original email was re-read and refused, or the route was switched
 * off. Nothing can have been sent, whatever stage the tap had reached.
 */
const REFUSED_BEFORE_SEND = new Set([
  "REPLY_SOURCE_CHANGED",
  "REPLY_SOURCE_UNAVAILABLE",
  "REPLY_SOURCE_RETRYABLE",
  "REPLY_SOURCE_REF_EXPIRED",
  "REPLY_SOURCE_REF_INVALID",
  "REPLY_ACCOUNT_CHANGED",
  "REPLY_TARGET_IS_OWNER",
  "REPLY_TARGET_AMBIGUOUS",
  "REPLY_RECIPIENT_INVALID",
  "REPLY_HEADERS_INVALID",
  "MAIL_REPLY_UNAVAILABLE",
  "GMAIL_READ_PERMISSION_REQUIRED",
  "SOURCE_BOUND_ATTACHMENT_UNSUPPORTED",
  "SOURCE_BINDING_CONFLICT",
]);

export function deliveryFailure(cause: unknown, sendRequestStarted: boolean): EmailDeliveryError {
  const unknown = () => new EmailDeliveryError(
    "We could not confirm delivery. Check Sent Mail before trying again.",
    502,
    "EMAIL_ACTION_OUTCOME_UNKNOWN",
  );
  if (cause instanceof EmailDeliveryError && REFUSED_BEFORE_SEND.has(cause.code ?? "")) {
    return cause;
  }
  if (cause instanceof EmailDeliveryError) {
    if (sendRequestStarted && (
      cause.code === "EMAIL_ACTION_ALREADY_USED" ||
      cause.code === "ACTION_NOT_SENDABLE" ||
      !cause.code ||
      (cause.status >= 500 && !["GMAIL_SEND_FAILED", "DELIVERY_FAILED"].includes(cause.code))
    )) return unknown();
    return cause;
  }
  // Once the Send request starts, a lost response may hide a successful send.
  return sendRequestStarted
    ? unknown()
    : new EmailDeliveryError("Mail could not be prepared. Review it and try again.", 500);
}

/** The server's address pattern, applied to each address a header names. */
const EMAIL_ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const RECIPIENT_FIELDS = [["to", "To"], ["cc", "Cc"], ["bcc", "Bcc"]] as const;

/** Commas inside a quoted display name, as in "Doe, Jane" <jane@x.com>, do not split. */
function splitRecipients(field: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of field) {
    if (escaped) {
      escaped = false;
    } else if (char === "\\" && quoted) {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** The angle-bracket address when present; the server's parser also drops inner spaces. */
function recipientAddress(recipient: string): string {
  const open = recipient.lastIndexOf("<");
  const address = open < 0 ? recipient : (recipient.slice(open + 1).split(">")[0] ?? "");
  return address.replace(/\s+/g, "");
}

function recipientFieldIsValid(field: string): boolean {
  return !/[\r\n]/.test(field) &&
    splitRecipients(field).every((recipient) => EMAIL_ADDRESS.test(recipientAddress(recipient)));
}

/**
 * Checks the envelope before Send closes the editor. It may be looser than
 * the server's normalize_draft, never stricter: the server stays the
 * authority, and an empty entry such as a trailing comma fails there too.
 */
export function recipientProblem(
  draft: Pick<EmailDraft, "to" | "cc" | "bcc">,
): EmailDeliveryError | null {
  const filled = RECIPIENT_FIELDS.filter(([field]) => draft[field].trim());
  if (!filled.length) {
    return new EmailDeliveryError("Add a recipient before sending.", 400, "MISSING_RECIPIENT");
  }
  const invalid = filled.find(([field]) => !recipientFieldIsValid(draft[field].trim()));
  return invalid
    ? new EmailDeliveryError(`Use a full email address in ${invalid[1]}.`, 400, "INVALID_RECIPIENTS")
    : null;
}
