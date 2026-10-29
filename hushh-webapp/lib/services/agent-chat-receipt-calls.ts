/** Device receipt calls for one chat turn: admitted requests and typed, honest failures. */
import { parseReceiptAnalysisRequest, type ReceiptAnalysisRequest, type ReceiptFunction } from "@/lib/mail/receipt-analysis";
import { ReceiptSnapshotMissingError, receiptSetupState, receiptUnavailableCode, unavailableReceiptAnalysis, type ReceiptSetupState } from "@/lib/mail/receipt-availability";
import { runReceiptFunction, type ReceiptStoreSession } from "@/lib/mail/receipt-store";

export type { ReceiptSetupState };

/** The streamed or final call arguments, admitted only for this owner turn; null refuses the call. */
export function receiptCallRequest(operation: ReceiptFunction, streamed: string | undefined, args: unknown,
  timezone: string | undefined, admissible: boolean): ReceiptAnalysisRequest | null {
  try {
    const request = parseReceiptAnalysisRequest(operation, streamed ? JSON.parse(streamed) : args);
    return admissible && request.timezone === timezone ? request : null;
  } catch {
    return null;
  }
}

// Read only after a missing snapshot, from the connector store the app already keeps. No network read.
async function knownGmailConnection(userId: string) {
  try {
    return (await import("@/lib/profile/gmail-connector-store")).getConnectorView(userId).status;
  } catch {
    return null;
  }
}

/**
 * One runner per turn. A failed device read becomes its typed unavailable
 * result, and a setup need (connect Gmail, or sync this device) is reported
 * at most once, while the turn's owner session is still current.
 */
export function receiptCallRunner(session: ReceiptStoreSession, onSetupNeeded: (state: ReceiptSetupState) => void) {
  let reported = false;
  return async (operation: ReceiptFunction, request: ReceiptAnalysisRequest) => {
    try {
      return await runReceiptFunction(session, operation, request);
    } catch (error) {
      const gmail = error instanceof ReceiptSnapshotMissingError ? await knownGmailConnection(session.userId) : null;
      const code = receiptUnavailableCode(error, gmail);
      const state = receiptSetupState(code);
      if (state && !reported && (session.isCurrent?.() ?? true)) {
        reported = true;
        try { onSetupNeeded(state); } catch { /* A UI hint never changes the turn's result. */ }
      }
      return unavailableReceiptAnalysis(operation, request, code);
    }
  };
}
