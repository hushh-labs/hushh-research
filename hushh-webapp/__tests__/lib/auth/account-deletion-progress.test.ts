import { describe, expect, it } from "vitest";

import type { AccountCleanupOperation } from "@/lib/auth/account-cleanup-operation";
import { accountDeletionSteps } from "@/lib/auth/account-deletion-progress";
import type { AccountRegistrationRecovery } from "@/lib/auth/account-registration";
import { nextRecoveryCheckDelay, recoveryPollPhase, registrationAdvancesAlone } from "@/lib/auth/account-recovery-cadence";

const cleanup = (patch: Partial<AccountCleanupOperation> = {}): AccountCleanupOperation => ({
  id: "b99efb85-c1f2-4714-8a63-614d774a25a3", state: "cleaning_up", credential_count: 0,
  local_erasure_confirmation_required: false, external_validity_unconfirmed_count: 0,
  inventory_sha256: "a".repeat(64), retry_after_seconds: 3, ...patch,
});
const NOW = 1_800_000_000_000;
const waiting: AccountRegistrationRecovery = { state: "waiting_for_identity", retry_at: NOW / 1000 + 42 };

describe("account deletion progress", () => {
  it("projects backend states only: done steps plus the current one, never future ones", () => {
    expect(accountDeletionSteps(cleanup(), null).map(({ id, status }) => [id, status]))
      .toEqual([["closed", "done"], ["erasing", "running"]]);
    // Stall copy comes only from the backend's delayed flag.
    expect(accountDeletionSteps(cleanup({ delayed: true }), null)[1].message).toMatch(/longer than usual/);
    expect(accountDeletionSteps(cleanup({ state: "action_required" }), null)[1].status).toBe("blocked");
    const signIn = accountDeletionSteps(null, waiting);
    expect(signIn.map(({ id, status }) => [id, status]))
      .toEqual([["closed", "done"], ["erasing", "done"], ["sign_in", "running"]]);
    // After erasure the account is deleted, not merely paused.
    expect(signIn[0].message).toBe("Your account was deleted.");
    expect(accountDeletionSteps(null, { state: "fresh_identity_required" }).at(-1))
      .toMatchObject({ id: "verify", status: "waiting" });
  });
});

describe("account recovery cadence", () => {
  it("never polls a state that waits for the person's consent or verification", () => {
    expect(registrationAdvancesAlone(waiting)).toBe(true);
    expect(registrationAdvancesAlone({ state: "cleanup_pending", reason: "cleanup_in_progress" })).toBe(true);
    for (const recovery of [
      { state: "fresh_identity_required" },
      { state: "action_required", reason: "identity_write_unconfirmed" },
      { state: "ready", review: { previous_generation: 0, cleanup_operation: "x", enrollment_operation: "y", expires_at: 1, terms_version: 1, digest: "d" } },
    ] as AccountRegistrationRecovery[]) expect(registrationAdvancesAlone(recovery)).toBe(false);
  });

  it("follows the backend hint while erasing and checks once just after retry_at", () => {
    expect(nextRecoveryCheckDelay(0, cleanup(), null, NOW)).toBe(3_000);
    expect(nextRecoveryCheckDelay(40, cleanup(), null, NOW)).toBe(30_000);
    // A stalled or person-gated cleanup keeps the original ladder.
    expect(nextRecoveryCheckDelay(1, cleanup({ delayed: true }), null, NOW)).toBe(5_000);
    expect(nextRecoveryCheckDelay(1, cleanup({ local_erasure_confirmation_required: true }), null, NOW)).toBe(5_000);
    expect(nextRecoveryCheckDelay(0, null, waiting, NOW)).toBe(42_500);
    expect(nextRecoveryCheckDelay(0, null, waiting, NOW + 50_000)).toBe(2_000);
    // An identical re-read must not restart the poller, or the bounds above never apply.
    expect(recoveryPollPhase({ ...waiting })).toBe(recoveryPollPhase({ ...waiting }));
    expect(recoveryPollPhase({ ...waiting, retry_at: waiting.retry_at + 1 })).not.toBe(recoveryPollPhase(waiting));
    // Generic availability failures keep the unchanged 2/5/10/30 s ladder.
    expect([0, 1, 2, 3, 9].map((attempt) => nextRecoveryCheckDelay(attempt, null, null, NOW)))
      .toEqual([2_000, 5_000, 10_000, 30_000, 30_000]);
  });
});
