/**
 * A receipt's single verified action, as the browser handles it.
 *
 * A leaf module with no imports so the saved index, the presentation rows and
 * the service can all share it. The reference is sealed by the server: it names
 * one link in one Mail message and holds no URL or Gmail id, so a link is only
 * ever resolved, once, when the owner clicks.
 */

export type ReceiptActionKind = "view_receipt" | "view_invoice" | "pay_due";

export type ReceiptAction = {
  kind: ReceiptActionKind;
  ref: string;
};

export const RECEIPT_ACTION_KINDS: readonly ReceiptActionKind[] = [
  "view_receipt",
  "view_invoice",
  "pay_due",
];

const RECEIPT_ACTION_REF = /^ra1\.[A-Za-z0-9_-]{4,596}$/;

export function isReceiptAction(value: unknown): value is ReceiptAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record.kind === "string" &&
    (RECEIPT_ACTION_KINDS as readonly string[]).includes(record.kind) &&
    typeof record.ref === "string" &&
    RECEIPT_ACTION_REF.test(record.ref)
  );
}

/** The button text for an action, in the owner's words. */
export function receiptActionLabel(kind: ReceiptActionKind): string {
  return {
    view_receipt: "View receipt",
    view_invoice: "View invoice",
    pay_due: "Resolve payment",
  }[kind];
}

/** What a saved action says when its reference no longer names a link. */
export const RECEIPT_ACTION_REFRESH_NOTICE = "Sync again to refresh this link";

/** What it says when Mail's login was rejected, so the link cannot be derived. */
export const RECEIPT_ACTION_RECONNECT_NOTICE =
  "Reconnect Mail, then sync again to refresh this link";
