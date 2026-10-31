import type { NativeDrawerRow } from "@/lib/capacitor/native-drawers";
import type { PayoutReceipt, FeeBreakdown } from "@/lib/services/payout-activity-service";
import { parsePayoutActivityItemId } from "@/lib/services/payout-activity-service";
import { holdNextStepCopy, holdReasonCopy } from "@/lib/payouts/review-copy";
import { adjustmentReason, contentLabel, depositTitle, dollars, kindLabel, maskedBankLabel,
  receiptDateTime, receiptDay, redemptionTitle, signedDollars } from "@/components/consent/payouts/receipts/activity-copy";
import type { PayoutReceiptAction } from "@/components/consent/payouts/receipts/receipt-ui";
import { copyToClipboard } from "@/lib/utils/clipboard";

/** Private presentation only. The strict service parser has already validated
 * monetary values. Provider IDs and executable URLs never enter row metadata. */
export function projectNativePayoutReceipt(receipt: PayoutReceipt, prefix: string, actions: Map<string, () => void | Promise<void>>,
  open: (id: string) => void, takeStep: (action: PayoutReceiptAction) => void, canOpen: (id: string) => boolean) {
  const rows: NativeDrawerRow[] = [];
  const value = (label: string, detail?: string | null) => {
    rows.push({ id: `${prefix}-${rows.length}`, label, ...(detail ? { detail } : {}), enabled: true, readOnly: true });
  };
  const link = (label: string, id: string, detail?: string | null) => {
    const handle = `${prefix}-${rows.length}`;
    rows.push({ id: handle, label, ...(detail ? { detail } : {}), enabled: canOpen(id), chevron: true });
    actions.set(handle, () => { if (canOpen(id)) open(id); });
  };
  const step = (label: string, action: PayoutReceiptAction) => {
    const handle = `${prefix}-${rows.length}`;
    rows.push({ id: handle, label, enabled: true, chevron: true });
    actions.set(handle, () => takeStep(action));
  };
  const reference = (label: string, text: string) => {
    value(label, text);
    const handle = `${prefix}-${rows.length}`;
    rows.push({ id: handle, label: `Copy ${label.toLowerCase()}`, enabled: true });
    actions.set(handle, async () => { await copyToClipboard(text); });
  };
  const fees = (breakdown: FeeBreakdown | null) => {
    if (!breakdown) return;
    const amount = (cents: number | null) => cents === null ? "Calculating" : dollars(cents);
    const deduction = (cents: number | null) => cents === null ? "Calculating" : dollars(-cents);
    value("Paid", amount(breakdown.grossCents));
    if (breakdown.refundCents) value("Refund", deduction(breakdown.refundCents));
    value("Hussh (3%)", deduction(breakdown.platformFeeCents));
    value("Stripe fees", deduction(breakdown.processingFeeCents));
    value("Your earnings", amount(breakdown.netCents));
  };
  if ("request" in receipt && receipt.request) {
    const request = receipt.request;
    value(request.label ?? "Document request", request.confirmedFiles !== null && request.expectedFiles !== null
      ? `${request.confirmedFiles} of ${request.expectedFiles} files delivered` : null);
  }
  switch (receipt.kind) {
    case "earning":
      fees(receipt.breakdown);
      if (["credited", "held", "reversed"].includes(receipt.status) && receipt.coins !== null) value("Hussh Coins", receipt.coins.toLocaleString());
      for (const stage of receipt.stages) value(({ paid: "Buyer paid", delivered: "Files delivered", credited: "Hussh Coins credited", held: "Under review", reversed: "Reversed" })[stage.stage], receiptDateTime(stage.at));
      if (receipt.cashOut) link(redemptionTitle(receipt.cashOut.status), receipt.cashOut.itemId);
      break;
    case "redemption": {
      value("Hussh Coins", receipt.coins.toLocaleString()); value("Amount", dollars(receipt.amountCents));
      const transfer = receipt.transfer;
      if (transfer.requestedAt) value("Requested", receiptDateTime(transfer.requestedAt));
      const at = transfer.status === "sent" ? transfer.sentAt ?? transfer.completedAt : transfer.status === "failed" ? transfer.completedAt : null;
      value(({ sent: "Sent to Stripe", failed: "Transfer failed", requested: "Sending to Stripe", unknown: "Checking transfer", unrecognized: "Status updating" })[transfer.status],
        at ? receiptDateTime(at) : transfer.status === "failed" ? "Coins are available again." : transfer.status === "unknown" ? "Coins stay reserved." : null);
      const reversal = receipt.reversal;
      if (reversal && reversal.status !== "none") value(redemptionTitle(receipt.status, reversal.status), reversal.at ? receiptDateTime(reversal.at) : null);
      if (transfer.status === "sent" && !(receipt.bankDeposit && receipt.funds?.status === "paid_out")) {
        const funds = receipt.funds;
        if (funds && funds.status !== "unknown") value(({ pending: "Settling in Stripe", available: "Available in Stripe", paid_out: "Paid out by Stripe" })[funds.status],
          funds.status === "pending" && funds.availableOn ? `Available ${receiptDay(funds.availableOn)}` : null);
      }
      if (receipt.bankDeposit) {
        const deposit = receipt.bankDeposit;
        link(depositTitle(deposit.status), deposit.id, [maskedBankLabel(deposit.bank), deposit.arrivalAt &&
          (deposit.status === "paid" ? receiptDay(deposit.arrivalAt) : ["pending", "in_transit"].includes(deposit.status) ? `Expected ${receiptDay(deposit.arrivalAt)}` : null)].filter(Boolean).join(" · "));
      }
      break;
    }
    case "deposit":
      if (receipt.createdAt) value("Created", receiptDateTime(receipt.createdAt));
      if (receipt.expectedArrivalAt && !["failed", "canceled"].includes(receipt.status)) value("Expected", receiptDay(receipt.expectedArrivalAt));
      value(depositTitle(receipt.status), receipt.status === "paid" && receipt.paidAt ? receiptDateTime(receipt.paidAt) : receipt.status === "failed" && receipt.failedAt ? receiptDateTime(receipt.failedAt) : null);
      if (receipt.actionRequired === "update_bank") step("Update your bank", "manage_bank");
      value(maskedBankLabel(receipt.bank) ?? "Bank not recorded");
      if (receipt.bankReference) reference("Bank reference", receipt.bankReference);
      if (!receipt.contents || receipt.contents.status === "not_applicable") value("Bank payouts may combine earnings from multiple requests.");
      else if (receipt.contents.status === "pending") value("Matching deposits…");
      else {
        for (const item of receipt.contents.items) {
          if (item.itemId) link(contentLabel(item), item.itemId, dollars(item.amountCents));
          else value(contentLabel(item), dollars(item.amountCents));
        }
        if (receipt.contents.otherCents !== 0) value("Other", dollars(receipt.contents.otherCents));
      }
      break;
    case "adjustment": {
      value(receipt.type === "earning_reversed" ? "Hussh Coins removed" : "Hussh Coins returned", signedDollars(receipt.type === "earning_reversed" ? -receipt.coins : receipt.coins));
      value("What changed", adjustmentReason(receipt.type));
      if (receipt.at) value("When", receiptDateTime(receipt.at));
      const related = parsePayoutActivityItemId(receipt.relatedItemId);
      if (related && receipt.relatedItemId) link(kindLabel(related.kind), receipt.relatedItemId);
      break;
    }
  }
  if ("review" in receipt && receipt.review) {
    value(holdReasonCopy(receipt.review.reason), holdNextStepCopy(receipt.review.nextStep));
    if (receipt.review.nextStep === "update_bank") step("Update your bank", "manage_bank");
    if (receipt.review.nextStep === "verify_details") step("Verify details", "verify");
  }
  if ("reference" in receipt && receipt.reference) reference("Hussh reference", receipt.reference);
  return rows;
}
