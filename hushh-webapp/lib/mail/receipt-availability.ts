/** Closed reasons a device receipt read can't answer, mirrored by the hub's receipt_result_contract.py. */
import type { ReceiptAnalysisRequest, ReceiptFunction } from "./receipt-analysis";
import type { GmailConnectionStatus } from "@/lib/services/gmail-receipts-service";

// The hub accepts exactly these sentences, keyed by code. Keep them identical.
export const RECEIPT_UNAVAILABLE_LIMITATIONS = {
  gmail_not_connected: "Gmail isn't connected. Connect Gmail so One can read your receipts.",
  receipts_not_synced: "Receipts haven't synced to this device yet. Open Mail receipts to sync, then ask again.",
  receipt_snapshot_unavailable: "The owner receipt snapshot could not be read. Sync Mail Receipts and ask again.",
} as const;
export type ReceiptUnavailableCode = keyof typeof RECEIPT_UNAVAILABLE_LIMITATIONS;
/** What the chat can offer under the answer: Connect Gmail, or a receipt sync on this device. */
export type ReceiptSetupState = "connect_required" | "sync_required";
type GmailConnection = Pick<GmailConnectionStatus, "configured" | "connected" | "revoked"> | null;

/** This device holds no saved receipts for the owner yet. Fixed text; no account or receipt detail. */
export class ReceiptSnapshotMissingError extends Error {
  readonly name = "ReceiptSnapshotMissingError";
  constructor() {
    super("No saved receipt snapshot is available. Open Mail Receipts and sync first.");
  }
}

/**
 * Only a missing snapshot is a setup state. It means "connect" only when the
 * connector store already knows Mail is disconnected; an unknown status never
 * claims that. Every other failure stays the generic unavailable code.
 */
export function receiptUnavailableCode(error: unknown, gmail: GmailConnection): ReceiptUnavailableCode {
  if (!(error instanceof ReceiptSnapshotMissingError)) return "receipt_snapshot_unavailable";
  return gmail?.configured && !(gmail.connected && !gmail.revoked) ? "gmail_not_connected" : "receipts_not_synced";
}

export function receiptSetupState(code: ReceiptUnavailableCode): ReceiptSetupState | null {
  if (code === "gmail_not_connected") return "connect_required";
  return code === "receipts_not_synced" ? "sync_required" : null;
}

export function unavailableReceiptAnalysis(operation: ReceiptFunction, request: ReceiptAnalysisRequest,
  code: ReceiptUnavailableCode = "receipt_snapshot_unavailable") {
  return { schema: "receipt_analysis.v1", operation, status: "unavailable", code,
    requested_range: { from: request.from_date, to: request.to_date, end_exclusive: true, timezone: request.timezone },
    source_freshness: null, snapshot_revision: null, canonical_transaction_count: null, matched_count: null, included_count: null,
    coverage: null, truncated: false, dedupe_policy: "Mail canonical groups; one transaction per saved group",
    refund_handling: { record_count: null, amount: null, net: null, policy: "Refund evidence unavailable." },
    cancellation_handling: "Unpaid, failed, cancelled and trial records are excluded from paid totals.",
    limitations: [RECEIPT_UNAVAILABLE_LIMITATIONS[code]], results: [] };
}

/**
 * Expand phase: an owner pod on receipt tools version 1 may run the older
 * validator, which admits only the generic unavailable result. Version 1 can't
 * tell the two apart, so every version 1 turn gets the generic code and sentence
 * until the web understands version 2. The hub admits every code.
 */
export function legacyReceiptResult(result: unknown): unknown {
  const value = result as { status?: unknown; code?: unknown } | null | undefined;
  const code = value?.status === "unavailable" ? value.code : null;
  return typeof code === "string" && code !== "receipt_snapshot_unavailable" && Object.hasOwn(RECEIPT_UNAVAILABLE_LIMITATIONS, code)
    ? { ...value, code: "receipt_snapshot_unavailable", limitations: [RECEIPT_UNAVAILABLE_LIMITATIONS.receipt_snapshot_unavailable] } : result;
}
