/**
 * A Receipts "price rise" finding, worded as one Overview update.
 *
 * Every number comes from the facts the mailbox check already validated
 * (`last_paid_minor`, `new_minor`, `currency`, `effective_on`). The only
 * arithmetic here is the difference of two such amounts in whole minor units, so
 * "₹600 more" can never be something no email shows. A finding that cannot be
 * stated exactly produces no update.
 */

import { formatMinor } from "@/lib/mail/receipt-money";
import type { NoticeFinding } from "@/lib/mail/receipt-notice";
import { shortDate } from "@/lib/mail/receipt-tracking-present";

export type ReceiptPriceUpdate = {
  /** The Receipts finding this update opens. */
  findingId: string;
  title: string;
  line: string;
};

function wholeMinor(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function receiptPriceUpdate(finding: NoticeFinding): ReceiptPriceUpdate | null {
  if (finding.kind !== "price_rise") return null;
  const currency = typeof finding.facts.currency === "string" ? finding.facts.currency : "";
  const last = wholeMinor(finding.facts.last_paid_minor);
  const next = wholeMinor(finding.facts.new_minor);
  if (!currency || last === null || next === null || next <= last) return null;
  const provider = finding.provider?.name?.trim() || "";
  const rise = formatMinor(next - last, currency);
  if (finding.facts.new_is_announced === true) {
    // Dated exactly as Receipts dates the same finding.
    const when = shortDate(typeof finding.facts.effective_on === "string" ? finding.facts.effective_on : null);
    return {
      findingId: finding.id,
      title: `${provider ? `${provider} renewal` : "Renewal"} increases by ${rise}`,
      line: `You paid ${formatMinor(last, currency)}. ${when ? `The ${when} renewal` : "The next renewal"} is ${formatMinor(next, currency)}.`,
    };
  }
  return {
    findingId: finding.id,
    title: `${provider ? `${provider} bill` : "Bill"} rose by ${rise}`,
    line: `Your latest bill is ${formatMinor(next, currency)}, up from ${formatMinor(last, currency)}.`,
  };
}
