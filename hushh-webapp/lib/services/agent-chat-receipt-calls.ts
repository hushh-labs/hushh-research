/** Device receipt calls for one chat turn: admitted requests and typed, honest failures. */
import { parseReceiptAnalysisRequest, type ReceiptAnalysisRequest, type ReceiptFunction } from "@/lib/mail/receipt-analysis";
import { ReceiptSnapshotMissingError, receiptSetupState, receiptUnavailableCode, unavailableReceiptAnalysis, type ReceiptSetupState } from "@/lib/mail/receipt-availability";
import type { DeviceReceiptSync } from "@/lib/mail/receipt-device-sync";
import { runReceiptFunction, type ReceiptStoreSession } from "@/lib/mail/receipt-store";

export type { ReceiptSetupState };

/**
 * The streamed or final call arguments, admitted only for this owner turn.
 * `invalid`: the arguments fail the schema, so the hub bound nothing and answers
 * the call itself. `refused`: the owner turn, its capacity or its zone don't match.
 */
export type ReceiptCallAdmission = { kind: "admitted"; request: ReceiptAnalysisRequest } | { kind: "invalid" } | { kind: "refused" };
export function receiptCallRequest(operation: ReceiptFunction, streamed: string | undefined, args: unknown,
  timezone: string | undefined, admissible: boolean): ReceiptCallAdmission {
  if (!admissible) return { kind: "refused" };
  let request: ReceiptAnalysisRequest;
  try {
    request = parseReceiptAnalysisRequest(operation, streamed ? JSON.parse(streamed) : args);
  } catch {
    return { kind: "invalid" };
  }
  return request.timezone === timezone ? { kind: "admitted", request } : { kind: "refused" };
}

// Read only after a missing snapshot, from the connector store the app already keeps. No network read.
async function knownGmailConnection(userId: string) {
  try {
    return (await import("@/lib/profile/gmail-connector-store")).getConnectorView(userId).status;
  } catch {
    return null;
  }
}

/** The shared, bounded Mail receipt sync. Any failure is a failed sync, never a claimed one. */
type DeviceSync = (session: ReceiptStoreSession, onStart: () => void) => Promise<DeviceReceiptSync>;
const syncOnDevice: DeviceSync = async (session, onStart) => {
  try {
    return await (await import("@/lib/mail/receipt-device-sync")).syncReceiptsOnDevice(session, onStart);
  } catch {
    return "failed";
  }
};

/**
 * One runner per turn. A device with no saved receipts and connected Mail syncs
 * once for the whole turn, then answers from what was saved, including the pages
 * a sync saved before it failed or ran out of time (their answer says the sync is
 * incomplete). A failed device read becomes its typed unavailable result. Each
 * card state is reported at most once, while the turn's owner session is current.
 */
export function receiptCallRunner(session: ReceiptStoreSession, onSetupNeeded: (state: ReceiptSetupState) => void,
  sync: DeviceSync = syncOnDevice) {
  const reported = new Set<ReceiptSetupState>();
  const report = (state: ReceiptSetupState) => {
    if (reported.has(state) || !(session.isCurrent?.() ?? true)) return;
    reported.add(state);
    try { onSetupNeeded(state); } catch { /* A UI hint never changes the turn's result. */ }
  };
  let synced: Promise<DeviceReceiptSync> | null = null;
  const syncOnce = () => synced ??= sync(session, () => report("syncing"));
  return async (operation: ReceiptFunction, request: ReceiptAnalysisRequest) => {
    let error: unknown;
    try {
      return await runReceiptFunction(session, operation, request);
    } catch (caught) {
      error = caught;
    }
    const gmail = error instanceof ReceiptSnapshotMissingError ? await knownGmailConnection(session.userId) : null;
    let code = receiptUnavailableCode(error, gmail);
    const outcome = code === "receipts_not_synced" ? await syncOnce() : "unavailable";
    if (outcome !== "unavailable") {
      try {
        const result = await runReceiptFunction(session, operation, request);
        report(outcome === "synced" ? "synced" : "sync_incomplete");
        return result;
      } catch (retry) {
        code = receiptUnavailableCode(retry, gmail);
      }
    }
    // A started sync never leaves "Syncing receipts…" on a turn that ended without an answer.
    const state = receiptSetupState(code) ?? (outcome === "unavailable" ? null : "sync_incomplete");
    if (state) report(state);
    return unavailableReceiptAnalysis(operation, request, code);
  };
}

/**
 * Waits for a turn's device receipt calls. Stop ends the wait at once (a joined
 * shared sync ignores the turn's abort), and the turn reports activity while it
 * waits so a long sync never reads as a quiet connection.
 */
export async function settleReceiptCalls<T>(calls: Iterable<Promise<T>>, signal: AbortSignal | undefined,
  onActivity: () => void, activityMs = 15_000): Promise<T[]> {
  let stop = () => undefined as void;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(new DOMException("Agent turn cancelled", "AbortError"));
    if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
  });
  onActivity();
  const timer = setInterval(onActivity, activityMs);
  try {
    return await Promise.race([Promise.all(calls), stopped]);
  } finally {
    clearInterval(timer);
    signal?.removeEventListener("abort", stop);
  }
}
