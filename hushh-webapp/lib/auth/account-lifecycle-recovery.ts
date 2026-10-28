import { ApiService } from "@/lib/services/api-service";
import { parseAccountCleanupOperation, type AccountCleanupOperation } from "./account-cleanup-operation";
import { parseAccountRegistrationRecovery, type AccountRegistrationRecovery } from "./account-registration";
import type { AuthSessionInvalidationCode } from "./session-invalidation";
import { hasJsonResponseContentType, readBoundedAccountSessionStatusBody, withinAccountSessionValidationBudget } from "./account-session-status";

type Terminal = { outcome: "terminal"; code: AuthSessionInvalidationCode };
// A registration result names the terminal evidence it replaces, so the caller
// still runs that departure's device purge before offering a new account.
type Recovery = Terminal | { outcome: "unavailable"; cleanup?: AccountCleanupOperation; registration?: AccountRegistrationRecovery; departure?: AuthSessionInvalidationCode };

/** Purpose-bound reads only. The AuthProvider caller retains owner/episode authority. */
export async function resolveAccountLifecycleRecovery(idToken: string, deadlineMs: number, terminal: Terminal): Promise<Recovery> {
  let knownTerminal = terminal;
  if (terminal.code === "account_not_found" || terminal.code === "account_deleted") {
    try {
      const response = await withinAccountSessionValidationBudget(ApiService.getAccountCleanupStatus(idToken), deadlineMs);
      if (response.ok && hasJsonResponseContentType(response)) {
        const body = JSON.parse(await readBoundedAccountSessionStatusBody(response, deadlineMs));
        const operation = parseAccountCleanupOperation(body?.operation);
        // Complete proves erasure, not shared-identity removal or signup readiness.
        if (operation?.state === "complete") knownTerminal = {outcome: "terminal", code: "account_deleted"};
        else if (operation) return {outcome: "unavailable", cleanup: operation};
      }
    } catch { /* Missing or unavailable evidence never becomes deletion success. */ }
  }
  try {
    const response = await withinAccountSessionValidationBudget(ApiService.getAccountRegistrationStatus(idToken), deadlineMs);
    // Existing rollout-off policy preserves the independently established result.
    // With admission on, a refused identity (missing Firebase user, review mint)
    // answers 401 instead and keeps that same result.
    if (response.status === 404 || response.status === 401) return knownTerminal;
    if (response.ok && hasJsonResponseContentType(response)) {
      const body = JSON.parse(await readBoundedAccountSessionStatusBody(response, deadlineMs));
      const registration = parseAccountRegistrationRecovery(body);
      if (registration) return {outcome: "unavailable", registration, departure: knownTerminal.code};
    }
  } catch { /* Keep identity for purpose-bound recovery, never admit it. */ }
  return {outcome: "unavailable"};
}
