/**
 * Run the device half of a voice-armed account reset or deletion.
 *
 * The server never executes these: the vault-owner authority they need is
 * resolved here (and may need a vault unlock this device has to show), and
 * the cleanup that must follow -- cache purge, local state, cookies,
 * sign-out -- is device-owned. So the tap issues a step bound to owner and
 * operation, this runs the existing lifecycle flow, and reports a typed
 * outcome. The report is not the truth: the server re-reads its own state
 * (`report_account_lifecycle`) and that is what One narrates.
 *
 * Pure: every side effect is a dependency, so the decisions here are unit
 * tested without a browser. The bridge wires the real ones.
 */

import type { DeleteAccountAuthResolution } from "@/lib/flows/delete-account";
import {
  classifyDeletionError,
  resolveResetOutcome,
} from "@/lib/profile/profile-action-outcomes";
import type { AccountResetResult } from "@/lib/services/account-service";

export const ACCOUNT_LIFECYCLE_STEP_KIND = "account_lifecycle" as const;

export type LifecycleOperation = "reset" | "delete";

/** The device's report. Only ever a hint to the server's verifier. */
export type LifecycleStepOutcome =
  | "reset"
  | "not_reset"
  | "deleted"
  | "needs_unlock"
  | "auth_failed"
  | "blocked_external"
  | "failed"
  | "unknown";

export type LifecycleStepReport = {
  status: "ok" | "failed";
  payload: { outcome: LifecycleStepOutcome; operation: LifecycleOperation; reason?: string };
};

export type LifecycleStepDeps = {
  /** The signed-in owner this device can act for; null when signed out. */
  currentUid: string | null;
  /** The vault-owner token already held, if the vault is unlocked here. */
  existingVaultOwnerToken: string | null;
  resolveAuth: (params: {
    userId: string;
    existingVaultOwnerToken: string | null;
  }) => Promise<DeleteAccountAuthResolution>;
  resetAccount: (token: string) => Promise<AccountResetResult>;
  /** Runs only after a backend-confirmed reset. */
  afterReset: (uid: string) => Promise<void>;
  executeDeletion: (params: { userId: string; vaultOwnerToken: string }) => Promise<void>;
  /** Runs only after a confirmed deletion; reporting happens before it. */
  afterDelete: (uid: string) => Promise<void>;
};

function fail(
  operation: LifecycleOperation,
  outcome: LifecycleStepOutcome,
  reason?: string,
): LifecycleStepReport {
  return { status: "failed", payload: { outcome, operation, ...(reason ? { reason } : {}) } };
}

function ok(operation: LifecycleOperation, outcome: LifecycleStepOutcome): LifecycleStepReport {
  return { status: "ok", payload: { outcome, operation } };
}

export function parseLifecycleStep(
  step: { kind: string; payload?: Record<string, unknown> } | null | undefined,
): { operation: LifecycleOperation; userId: string } | null {
  if (!step || step.kind !== ACCOUNT_LIFECYCLE_STEP_KIND) return null;
  const operation = step.payload?.operation;
  const userId = step.payload?.user_id;
  if (operation !== "reset" && operation !== "delete") return null;
  if (typeof userId !== "string" || !userId.trim()) return null;
  return { operation, userId: userId.trim() };
}

export async function runAccountLifecycleStep(
  step: { kind: string; payload?: Record<string, unknown> },
  deps: LifecycleStepDeps,
): Promise<LifecycleStepReport> {
  const parsed = parseLifecycleStep(step);
  if (!parsed) return fail("reset", "failed", "malformed_step");
  const { operation, userId } = parsed;

  // Owner binding: the step names the owner who tapped; this device must be
  // signed in as exactly that person, or nothing runs.
  if (!deps.currentUid || deps.currentUid !== userId) {
    return fail(operation, "auth_failed", "owner_mismatch");
  }

  let auth: DeleteAccountAuthResolution;
  try {
    auth = await deps.resolveAuth({
      userId,
      existingVaultOwnerToken: deps.existingVaultOwnerToken,
    });
  } catch {
    return fail(operation, "auth_failed", "auth_resolution_failed");
  }
  if (auth.kind === "needs_unlock") {
    // An honest handoff, not a change: the vault must be unlocked on screen.
    return ok(operation, "needs_unlock");
  }
  const token = auth.token;

  if (operation === "reset") {
    let result: AccountResetResult;
    try {
      result = await deps.resetAccount(token);
    } catch {
      // A lost response after a possible commit. Never "not reset": the
      // server verifies from its own stamp.
      return fail("reset", "unknown", "reset_request_failed");
    }
    const outcome = resolveResetOutcome(result);
    if (outcome !== "reset") return ok("reset", outcome);
    try {
      await deps.afterReset(userId);
    } catch {
      // The backend confirmed the reset; a failed local cleanup does not
      // un-reset it. Report reset -- the server's stamp agrees.
    }
    return ok("reset", "reset");
  }

  try {
    await deps.executeDeletion({ userId, vaultOwnerToken: token });
  } catch (error) {
    const classified = classifyDeletionError(error);
    return classified === "unknown"
      ? fail("delete", "unknown", "deletion_outcome_uncertain")
      : ok("delete", classified);
  }
  // Report first: afterDelete signs out and may tear this session down.
  const report = ok("delete", "deleted");
  void deps.afterDelete(userId).catch(() => undefined);
  return report;
}
