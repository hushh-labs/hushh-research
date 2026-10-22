"use client";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ProfileAccountBankIcon } from "@/components/profile/profile-your-account-icons";
import { ProfileSecondaryReceiptIcon } from "@/components/profile/profile-secondary-icons";
import {
  parsePayoutActivityItemId,
  type AdjustmentReceipt,
  type DepositActivityStatus,
  type DepositReceipt,
  type EarningReceipt,
  type ReceiptRequest,
  type ReceiptStage,
  type RedemptionReceipt,
} from "@/lib/services/payout-activity-service";

import {
  adjustmentReason,
  contentLabel,
  depositTitle,
  dollars,
  kindLabel,
  maskedBankLabel,
  receiptDateTime,
  receiptDay,
  redemptionTitle,
  signedDollars,
} from "./activity-copy";
import {
  ReceiptReferenceRow,
  ReceiptReviewSection,
  ReceiptStageRow,
  ReceiptValueRow,
  type PayoutReceiptAction,
  type StageTone,
} from "./receipt-ui";

/** Opens another item's receipt; undefined when that receipt is already open beneath. */
export type OpenLinkedItem = (itemId: string) => (() => void) | undefined;

const amount = (cents: number | null) => (cents === null ? "Calculating" : dollars(cents));
const deduction = (cents: number | null) => (cents === null ? "Calculating" : cents > 0 ? dollars(-cents) : dollars(0));

function RequestGroup({ request }: { request: ReceiptRequest | null }) {
  if (!request) return null;
  const files = request.confirmedFiles !== null && request.expectedFiles !== null
    ? `${request.confirmedFiles} of ${request.expectedFiles} files delivered` : null;
  return (
    <SettingsGroup title="Request">
      <ReceiptValueRow icon={ProfileSecondaryReceiptIcon} title={request.label ?? "Document request"} description={files} />
    </SettingsGroup>
  );
}

function ReferenceGroup({ reference }: { reference: string | null }) {
  return reference ? <SettingsGroup><ReceiptReferenceRow label="Hussh reference" value={reference} /></SettingsGroup> : null;
}

const EARNING_STAGES: Record<ReceiptStage["stage"], { title: string; tone: StageTone }> = {
  paid: { title: "Buyer paid", tone: "done" },
  delivered: { title: "Files delivered", tone: "done" },
  credited: { title: "Hussh Coins credited", tone: "done" },
  held: { title: "Under review", tone: "review" },
  reversed: { title: "Reversed", tone: "problem" },
};

export function EarningReceiptSections({ receipt, openItem, onAction }: {
  receipt: EarningReceipt; openItem: OpenLinkedItem; onAction?: (action: PayoutReceiptAction) => void;
}) {
  const breakdown = receipt.breakdown;
  // Before credit the server's figure is the expected earning, not coins yet.
  const coins = ["credited", "held", "reversed"].includes(receipt.status) ? receipt.coins : null;
  return (
    <>
      <RequestGroup request={receipt.request} />
      {breakdown || coins !== null ? (
        <SettingsGroup title="Amount">
          {breakdown ? (
            <>
              <ReceiptValueRow title="Paid" value={amount(breakdown.grossCents)} />
              {breakdown.refundCents ? <ReceiptValueRow title="Refund" value={deduction(breakdown.refundCents)} /> : null}
              <ReceiptValueRow title="Hussh (3%)" value={deduction(breakdown.platformFeeCents)} />
              <ReceiptValueRow title="Stripe fees" value={deduction(breakdown.processingFeeCents)} />
              <ReceiptValueRow title="Your earnings" value={amount(breakdown.netCents)} />
            </>
          ) : null}
          {coins !== null ? <ReceiptValueRow title="Hussh Coins" value={coins.toLocaleString()} /> : null}
        </SettingsGroup>
      ) : null}
      {receipt.stages.length ? (
        <SettingsGroup title="Status">
          {receipt.stages.map((stage, index) => (
            <ReceiptStageRow key={`${stage.stage}:${index}`} title={EARNING_STAGES[stage.stage].title}
              tone={EARNING_STAGES[stage.stage].tone} value={receiptDateTime(stage.at)} />
          ))}
        </SettingsGroup>
      ) : null}
      {receipt.cashOut ? (
        <SettingsGroup title="Redemption">
          <ReceiptStageRow title={redemptionTitle(receipt.cashOut.status)} tone={receipt.cashOut.status === "succeeded" ? "done"
            : receipt.cashOut.status === "failed" ? "problem" : "waiting"} onOpen={openItem(receipt.cashOut.itemId)} />
        </SettingsGroup>
      ) : null}
      {receipt.review ? <ReceiptReviewSection review={receipt.review} onAction={onAction} /> : null}
      <ReferenceGroup reference={receipt.reference} />
    </>
  );
}

function depositTone(status: DepositActivityStatus): StageTone {
  return status === "paid" ? "done" : status === "failed" || status === "canceled" ? "problem" : "waiting";
}

function TransferStage({ transfer }: { transfer: RedemptionReceipt["transfer"] }) {
  switch (transfer.status) {
    case "sent": {
      const at = transfer.sentAt ?? transfer.completedAt;
      return <ReceiptStageRow title="Sent to Stripe" tone="done" value={at ? receiptDateTime(at) : null} />;
    }
    case "failed":
      return <ReceiptStageRow title="Transfer failed" description="Coins are available again." tone="problem"
        value={transfer.completedAt ? receiptDateTime(transfer.completedAt) : null} />;
    case "requested": return <ReceiptStageRow title="Sending to Stripe" tone="waiting" />;
    case "unknown": return <ReceiptStageRow title="Checking transfer" description="Coins stay reserved." tone="waiting" />;
    case "unrecognized": return <ReceiptStageRow title="Status updating" tone="waiting" />;
  }
}

function ReversalStage({ reversal }: { reversal: RedemptionReceipt["reversal"] }) {
  switch (reversal?.status) {
    case "reversed":
      return <ReceiptStageRow title="Transfer reversed" tone="problem" value={reversal.at ? receiptDateTime(reversal.at) : null} />;
    case "due": case "unknown": return <ReceiptStageRow title="Recovery pending" tone="waiting" />;
    case "manual_review": return <ReceiptStageRow title="Refund under review" tone="review" />;
    case "unrecognized": return <ReceiptStageRow title="Status updating" tone="waiting" />;
    default: return null;
  }
}

function FundsStage({ funds }: { funds: RedemptionReceipt["funds"] }) {
  switch (funds?.status) {
    case "pending":
      return <ReceiptStageRow title="Settling in Stripe" tone="waiting"
        value={funds.availableOn ? `Available ${receiptDay(funds.availableOn)}` : null} />;
    case "available": return <ReceiptStageRow title="Available in Stripe" tone="done" />;
    case "paid_out": return <ReceiptStageRow title="Paid out by Stripe" tone="done" />;
    default: return null;
  }
}

function arrival(status: DepositActivityStatus, at: string | null): string | null {
  if (!at) return null;
  if (status === "paid") return receiptDay(at);
  return status === "pending" || status === "in_transit" ? `Expected ${receiptDay(at)}` : null;
}

export function RedemptionReceiptSections({ receipt, openItem, onAction }: {
  receipt: RedemptionReceipt; openItem: OpenLinkedItem; onAction?: (action: PayoutReceiptAction) => void;
}) {
  const { transfer, bankDeposit } = receipt;
  return (
    <>
      <RequestGroup request={receipt.request} />
      <SettingsGroup title="Amount">
        <ReceiptValueRow title="Hussh Coins" value={receipt.coins.toLocaleString()} />
        <ReceiptValueRow title="Amount" value={dollars(receipt.amountCents)} />
      </SettingsGroup>
      <SettingsGroup title="Status">
        {transfer.requestedAt ? <ReceiptStageRow title="Requested" tone="done" value={receiptDateTime(transfer.requestedAt)} /> : null}
        <TransferStage transfer={transfer} />
        <ReversalStage reversal={receipt.reversal} />
        {transfer.status === "sent" && !(bankDeposit && receipt.funds?.status === "paid_out")
          ? <FundsStage funds={receipt.funds} /> : null}
        {bankDeposit ? (
          <ReceiptStageRow title={depositTitle(bankDeposit.status)} description={maskedBankLabel(bankDeposit.bank)}
            tone={depositTone(bankDeposit.status)} value={arrival(bankDeposit.status, bankDeposit.arrivalAt)}
            onOpen={openItem(bankDeposit.id)} />
        ) : null}
      </SettingsGroup>
      {receipt.review ? <ReceiptReviewSection review={receipt.review} onAction={onAction} /> : null}
      <ReferenceGroup reference={receipt.reference} />
    </>
  );
}

function IncludesGroup({ contents, openItem }: { contents: DepositReceipt["contents"]; openItem: OpenLinkedItem }) {
  if (contents?.status === "complete" && contents.items.length === 0 && contents.otherCents === 0) return null;
  if (!contents || contents.status === "not_applicable") {
    return <HelperText className="profile-account-note px-1 pt-3">Bank payouts may combine earnings from multiple requests.</HelperText>;
  }
  return (
    <SettingsGroup title="Includes">
      {contents.status === "pending" ? <ReceiptStageRow title="Matching deposits…" tone="waiting" /> : null}
      {contents.status === "complete" ? contents.items.map((item, index) => (
        <ReceiptValueRow key={`${item.itemId ?? "item"}:${index}`} title={contentLabel(item)} value={dollars(item.amountCents)}
          onOpen={item.itemId ? openItem(item.itemId) : undefined} />
      )) : null}
      {contents.status === "complete" && contents.otherCents !== 0
        ? <ReceiptValueRow title="Other" value={dollars(contents.otherCents)} /> : null}
    </SettingsGroup>
  );
}

export function DepositReceiptSections({ receipt, openItem, onAction }: {
  receipt: DepositReceipt; openItem: OpenLinkedItem; onAction?: (action: PayoutReceiptAction) => void;
}) {
  const { status } = receipt;
  const ended = status === "failed" || status === "canceled";
  return (
    <>
      <SettingsGroup title="Status">
        {receipt.createdAt ? <ReceiptStageRow title="Created" tone="done" value={receiptDateTime(receipt.createdAt)} /> : null}
        {receipt.expectedArrivalAt && !ended ? (
          <ReceiptStageRow title="Expected" tone={status === "paid" ? "done" : "waiting"} value={receiptDay(receipt.expectedArrivalAt)} />
        ) : null}
        {status === "paid" ? <ReceiptStageRow title="Paid" tone="done" value={receipt.paidAt ? receiptDateTime(receipt.paidAt) : null} /> : null}
        {status === "failed" ? <ReceiptStageRow title="Failed" tone="problem" value={receipt.failedAt ? receiptDateTime(receipt.failedAt) : null} /> : null}
        {status === "canceled" ? <ReceiptStageRow title="Canceled" tone="problem" /> : null}
        {status === "unrecognized" ? <ReceiptStageRow title="Status updating" tone="waiting" /> : null}
      </SettingsGroup>
      {receipt.actionRequired === "update_bank" ? (
        <SettingsGroup>
          {onAction ? (
            <ReceiptStageRow title="Update your bank" description="Opens your bank settings in Stripe." tone="problem"
              onOpen={() => onAction("manage_bank")} />
          ) : <ReceiptStageRow title="Update your bank" description="Use Manage bank on Payouts." tone="problem" />}
        </SettingsGroup>
      ) : null}
      <SettingsGroup title="Bank">
        {/* The bank this deposit went to, never today's default bank. */}
        <ReceiptValueRow icon={ProfileAccountBankIcon} title={maskedBankLabel(receipt.bank) ?? "Bank not recorded"} />
        {receipt.bankReference ? <ReceiptReferenceRow label="Bank reference" value={receipt.bankReference} /> : null}
      </SettingsGroup>
      <IncludesGroup contents={receipt.contents} openItem={openItem} />
    </>
  );
}

export function AdjustmentReceiptSections({ receipt, openItem }: { receipt: AdjustmentReceipt; openItem: OpenLinkedItem }) {
  const removed = receipt.type === "earning_reversed";
  const related = parsePayoutActivityItemId(receipt.relatedItemId);
  return (
    <>
      <SettingsGroup title="What changed">
        <SettingsRow title={removed ? "Hussh Coins removed" : "Hussh Coins returned"} description={adjustmentReason(receipt.type)}
          trailing={<span className="tabular-nums">{signedDollars(removed ? -receipt.coins : receipt.coins)}</span>} />
        {receipt.at ? <ReceiptValueRow title="When" value={receiptDateTime(receipt.at)} /> : null}
      </SettingsGroup>
      <RequestGroup request={receipt.request} />
      {related && receipt.relatedItemId ? (
        <SettingsGroup>
          <ReceiptValueRow title={kindLabel(related.kind)} onOpen={openItem(receipt.relatedItemId)} />
        </SettingsGroup>
      ) : null}
      <ReferenceGroup reference={receipt.reference} />
    </>
  );
}
