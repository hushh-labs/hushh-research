import { useState } from "react";
import { createRoot } from "react-dom/client";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "../../components/app-ui/app-page-shell";
import {
  PageHeader,
  SectionHeader,
} from "../../components/app-ui/page-sections";
import { SurfaceStack } from "../../components/app-ui/surfaces";
import { GmailReceiptOnboardingHero } from "../../components/gmail/gmail-receipt-onboarding-hero";
import { GmailRecentReceipts } from "../../components/gmail/gmail-recent-receipts";
import { GmailWorkspaceNavigation } from "../../components/gmail/gmail-workspace-navigation";
import type { ReceiptListItem } from "../../lib/services/gmail-receipts-service";

const receiptStatuses: Array<ReceiptListItem["status"]> = [
  "paid",
  "overdue",
  "renewal_due",
  "cancelled",
  "refunded",
  "delivered",
  null,
  "paid",
  "trial",
  "payment_failed",
  "paid",
];

const receipts: ReceiptListItem[] = [
  [1, "myntra.com", "MYNTRA-1", 1299],
  [2, "myntra.com", "MYNTRA-2", 849],
  [3, "myntra.com", "MYNTRA-3", null],
  [4, "amazon.com", "AMAZON-1", 2450],
  [5, "apple.com", "APPLE-1", 99],
  [6, "paypal.com", "PAYPAL-1", 375],
  [7, "unknown.example", "UNKNOWN-1", 540],
  [8, "amazon.com", "AMAZON-2", 699],
  [9, "apple.com", "APPLE-2", 129],
  [10, "amazon.com", "AMAZON-3", 299],
  [11, "apple.com", "APPLE-3", 199],
].map(([id, domain, orderId, amount]) => ({
  id: Number(id),
  source_id: `fixture-source-${id}`,
  receipt_key: `fixture-source-${id}`,
  source_kind: "gmail_live" as const,
  gmail_message_id: `message-${id}`,
  from_email: `ship-confirm@${domain}`,
  merchant_name:
    domain === "unknown.example"
      ? null
      : String(domain).split(".")[0].replace(/^./, (value) => value.toUpperCase()),
  merchant_domain: domain === "unknown.example" ? null : String(domain),
  order_id: String(orderId),
  subject: `Receipt for ${orderId}`,
  preview: `Stored email preview for ${orderId}`,
  event_type: "purchase" as const,
  status: receiptStatuses[Number(id) - 1],
  attention_state:
    receiptStatuses[Number(id) - 1] === "overdue" ||
    receiptStatuses[Number(id) - 1] === "payment_failed"
      ? ("needs_attention" as const)
      : ("none" as const),
  category: Number(id) === 7 ? ("Other" as const) : ("Shopping" as const),
  category_confidence: 0.95,
  amount: typeof amount === "number" ? amount : null,
  currency: "INR",
  receipt_date:
    Number(id) <= 4
      ? `2026-10-${String(11 - Number(id)).padStart(2, "0")}T12:00:00Z`
      : `2026-09-${String(35 - Number(id)).padStart(2, "0")}T12:00:00Z`,
}));

function Fixture() {
  const [syncStarted, setSyncStarted] = useState(false);

  return (
    <AppPageShell
      className="bg-background py-8 text-foreground lg:pt-[80px]"
      width="agent"
    >
      <AppPageHeaderRegion className="mx-auto max-w-[820px]">
        <PageHeader
          className="[&_[data-slot=page-header-copy]]:!space-y-3"
          description="Connected to your Mail"
          title="Mail"
          titleRole="agent"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion className="mx-auto !mt-0 max-w-[820px]">
        <SurfaceStack compact>
          <GmailWorkspaceNavigation onValueChange={() => {}} value="receipts" />
          <GmailReceiptOnboardingHero
            onStartReceiptSync={() => setSyncStarted(true)}
            syncing={syncStarted}
            statusMessage={syncStarted ? "Looking through your recent purchases…" : null}
            progressPercent={syncStarted ? 4 : null}
            syncAvailable
          />
          <section
            aria-labelledby="fixture-recent-receipts-title"
            className="space-y-3"
            data-testid="recent-receipts"
          >
            <SectionHeader
              id="fixture-recent-receipts-title"
              title="Recent receipts"
            />
            <GmailRecentReceipts
              accountKey="reviewer@example.com"
              loadReceiptDetail={async (sourceId) => {
                const item = receipts.find(
                  (receipt) => receipt.source_id === sourceId,
                );
                if (!item) throw new Error("Fixture receipt not found.");
                return {
                  item,
                  email_excerpt: item.preview
                    ? {
                        kind: "email_excerpt",
                        label: "Email preview",
                        text: item.preview,
                        truncated: false,
                      }
                    : null,
                };
              }}
              receipts={receipts}
            />
          </section>
          <output
            aria-live="polite"
            className="sr-only"
            data-testid="receipt-sync-status"
          >
            {syncStarted ? "receipt sync started" : "receipt sync not started"}
          </output>
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
