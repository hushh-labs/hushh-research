import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { GmailRecentReceipts } from "@/components/gmail/gmail-recent-receipts";
import { getVerifiedReceiptMerchant } from "@/lib/mail/receipt-merchant-registry";
import { captureReceiptSnapshot, receiptSnapshotRows, type ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { loadReceiptSnapshot, receiptStoreVersion, writeReceiptSnapshot } from "@/lib/mail/receipt-store";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import type { DurableVersion } from "@/lib/services/secure-durable-resource-service";
import { SecureDurableResourceService } from "@/lib/services/secure-durable-resource-service";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
// Synthetic fixture authority is recreated after reload; no key is persisted.
const session = { userId: "synthetic-owner", vaultKey: "12".repeat(32), vaultOwnerToken: "synthetic-owner-token" };
const account = "synthetic-mail-account";
const branding = new URLSearchParams(location.search).get("brands") === "true";
const receipts: ReceiptListItem[] = Array.from({ length: 13 }, (_, i) => ({
  id: i + 1, source_id: `synthetic-source-${i}`, gmail_message_id: `RAW_PROVIDER_${i}`,
  subject: "RAW_SUBJECT", from_email: "raw@example.com", cleaned_preview: "RAW_PASSAGE", short_detail: "RAW_DETAIL",
  merchant_name: branding && i === 0 ? "Internshala Trainings" : branding && i === 1 ? "Udemy" : i % 2 ? "Amazon" : "Apple",
  merchant_domain: branding && i === 0 ? "internshala.com" : branding && i === 1 ? "email.udemy.com" : i % 2 ? "amazon.com" : "apple.com",
  category: "Shopping", category_confidence: 1, amount: 10 + i, amount_decimal: `${10 + i}.00`, currency: "USD",
  status: "paid", event_type: "purchase", document_kind: "receipt", identifiers: [{ kind: "order", value: `ORDER-${i}` }], transaction_date: "October 1, 2026", attention_date: "October 18",
}));
function Fixture() {
  const [saved, setSaved] = useState<ReceiptSnapshot | null>(null);
  const [mode, setMode] = useState("loading");
  const [feedback, setFeedback] = useState("");
  const pending = useRef<{ snapshot: ReceiptSnapshot; version: DurableVersion } | null>(null);
  useEffect(() => { publishValidatedAuthSessionOwner(session.userId); void loadReceiptSnapshot(session, account).then(result => { setSaved(result?.value ?? null); setMode(result ? "restored" : "live"); }); }, []);
  const persist = async () => {
    const version = await receiptStoreVersion(session.userId, account);
    const snapshot = await captureReceiptSnapshot(receipts, account, { partial: false, truncated: false, source_count: receipts.length, window_from: null, window_to: null, source: "gmail_live" }, new Date("2026-10-13T00:00:00Z"));
    await writeReceiptSnapshot(session, snapshot, version); setMode("persisted");
  };
  const failRefresh = async () => {
    const version = await receiptStoreVersion(session.userId, account);
    const empty = await captureReceiptSnapshot([], account, { partial: false, truncated: false, source_count: 0, window_from: null, window_to: null, source: "gmail_live" });
    try { await writeReceiptSnapshot({ ...session, vaultKey: "invalid-key" }, empty, version); }
    catch { setFeedback("failed-refresh-kept-previous"); }
  };
  const delayScan = async () => {
    const version = await receiptStoreVersion(session.userId, account);
    const snapshot = await captureReceiptSnapshot(receipts, account, { partial: false, truncated: false, source_count: receipts.length, window_from: null, window_to: null, source: "gmail_live" });
    pending.current = { snapshot, version }; setFeedback("scan-pending");
  };
  const finishScan = async () => {
    if (!pending.current) return;
    const { snapshot, version } = pending.current; pending.current = null;
    try { await writeReceiptSnapshot(session, snapshot, version); setFeedback("unexpected-stale-save"); }
    catch { setFeedback("stale-scan-rejected"); }
  };
  return <div style={{ maxWidth: 820, padding: 20 }}>
    <p role="status">{mode}</p><p data-testid="storage-feedback">{feedback}</p>
    <button onClick={() => void persist()}>Persist synthetic receipts</button>
    <button onClick={() => void SecureDurableResourceService.purgeUser(session.userId).then(() => { setSaved(null); setMode("reset"); })}>Reset synthetic receipts</button>
    {mode !== "loading" && mode !== "reset" ? <div data-testid="saved-receipt-list"><GmailRecentReceipts accountKey={account}
      receipts={saved ? [] : receipts} savedRows={saved ? receiptSnapshotRows(saved) : undefined}
      loadReceiptDetail={async key => { const row = saved?.rows.find(r => r.events.some(e => e.ref === key)); return {
        item: { id: 0, gmail_message_id: "", merchant_name: row?.merchant ?? "Apple", merchant_domain: getVerifiedReceiptMerchant(row?.brand)?.logoDomain ?? "apple.com", category: row?.category ?? "Shopping", category_confidence: 1, amount: Number(row?.amount ?? "10.00"), currency: "USD", status: "paid", identifiers: row?.identifiers ?? [], transaction_date: row?.transaction_date ?? "2026-10-01" },
        source_evidence: [], email_excerpt: null, live_unavailable: "Reconnect Mail or sync again to load the original email and source evidence.",
      }; }} /></div> : null}
    <button onClick={() => void failRefresh()}>Fail synthetic refresh</button>
    <button onClick={() => void delayScan()}>Start delayed synthetic scan</button>
    <button onClick={() => void finishScan()}>Finish delayed synthetic scan</button>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
