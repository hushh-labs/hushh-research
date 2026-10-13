import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { GmailRecentReceipts } from "@/components/gmail/gmail-recent-receipts";
import { captureReceiptSnapshot, receiptSnapshotRows, type ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { loadReceiptSnapshot, receiptStoreVersion, writeReceiptSnapshot } from "@/lib/mail/receipt-store";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { SecureDurableResourceService } from "@/lib/services/secure-durable-resource-service";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
// Synthetic fixture authority is recreated after reload; no key is persisted.
const session = { userId: "synthetic-owner", vaultKey: "12".repeat(32), vaultOwnerToken: "synthetic-owner-token" };
const account = "synthetic-mail-account";
const receipts: ReceiptListItem[] = Array.from({ length: 13 }, (_, i) => ({
  id: i + 1, source_id: `synthetic-source-${i}`, gmail_message_id: `RAW_PROVIDER_${i}`,
  subject: "RAW_SUBJECT", from_email: "raw@example.com", cleaned_preview: "RAW_PASSAGE", short_detail: "RAW_DETAIL",
  merchant_name: i % 2 ? "Amazon" : "Apple", merchant_domain: i % 2 ? "amazon.com" : "apple.com",
  category: "Shopping", category_confidence: 1, amount: 10 + i, amount_decimal: `${10 + i}.00`, currency: "USD",
  status: "paid", event_type: "purchase", document_kind: "receipt", identifiers: [{ kind: "order", value: `ORDER-${i}` }], transaction_date: "2026-10-01",
}));
function Fixture() {
  const [saved, setSaved] = useState<ReceiptSnapshot | null>(null);
  const [mode, setMode] = useState("loading");
  useEffect(() => { publishValidatedAuthSessionOwner(session.userId); void loadReceiptSnapshot(session, account).then(result => { setSaved(result?.value ?? null); setMode(result ? "restored" : "live"); }); }, []);
  const persist = async () => {
    const version = await receiptStoreVersion(session.userId, account);
    const snapshot = await captureReceiptSnapshot(receipts, account, { partial: false, truncated: false, source_count: receipts.length, window_from: null, window_to: null, source: "gmail_live" }, new Date("2026-10-13T00:00:00Z"));
    await writeReceiptSnapshot(session, snapshot, version); setMode("persisted");
  };
  return <div style={{ maxWidth: 820, padding: 20 }}>
    <p role="status">{mode}</p><button onClick={() => void persist()}>Persist synthetic receipts</button>
    <button onClick={() => void SecureDurableResourceService.purgeUser(session.userId).then(() => { setSaved(null); setMode("reset"); })}>Reset synthetic receipts</button>
    {mode !== "loading" && mode !== "reset" ? <div data-testid="saved-receipt-list"><GmailRecentReceipts accountKey={account}
      receipts={saved ? [] : receipts} savedRows={saved ? receiptSnapshotRows(saved) : undefined}
      loadReceiptDetail={async key => { const row = saved?.rows.find(r => r.events.some(e => e.ref === key)); return {
        item: { id: 0, gmail_message_id: "", merchant_name: row?.merchant ?? "Apple", merchant_domain: row?.brand === "amazon" ? "amazon.com" : "apple.com", category: row?.category ?? "Shopping", category_confidence: 1, amount: Number(row?.amount ?? "10.00"), currency: "USD", status: "paid", identifiers: row?.identifiers ?? [], transaction_date: row?.transaction_date ?? "2026-10-01" },
        source_evidence: [], email_excerpt: null, live_unavailable: "Reconnect Mail or sync again to load the original email and source evidence.",
      }; }} /></div> : null}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
