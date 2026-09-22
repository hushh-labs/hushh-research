import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE,
  AccountDeletionOutcomeUncertainError,
} from "@/lib/flows/delete-account";
import {
  parseLifecycleStep,
  runAccountLifecycleStep,
  type LifecycleStepDeps,
} from "@/lib/one-voice/account-lifecycle-step";
import { ApiError } from "@/lib/services/api-client";

const UID = "uid-owner";

const step = (operation: "reset" | "delete", user_id = UID) => ({
  kind: "account_lifecycle",
  payload: { operation, user_id, issued_at_ms: 1, timeout_s: 180 },
});

function deps(overrides: Partial<LifecycleStepDeps> = {}): LifecycleStepDeps & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    currentUid: UID,
    existingVaultOwnerToken: "HCT:held",
    resolveAuth: vi.fn(async () => {
      calls.push("resolveAuth");
      return { kind: "use_existing_token" as const, token: "HCT:held", hasVault: true as const };
    }),
    resetAccount: vi.fn(async () => {
      calls.push("resetAccount");
      return { success: true, account_reset: true };
    }),
    afterReset: vi.fn(async () => {
      calls.push("afterReset");
    }),
    executeDeletion: vi.fn(async () => {
      calls.push("executeDeletion");
    }),
    afterDelete: vi.fn(async () => {
      calls.push("afterDelete");
    }),
    ...overrides,
  };
}

describe("parseLifecycleStep", () => {
  it("accepts only the account_lifecycle kind with a known operation and an owner", () => {
    expect(parseLifecycleStep(step("reset"))).toEqual({ operation: "reset", userId: UID });
    expect(parseLifecycleStep({ kind: "publish_location_envelopes", payload: {} })).toBeNull();
    expect(parseLifecycleStep({ kind: "account_lifecycle", payload: { operation: "wipe", user_id: UID } })).toBeNull();
    expect(parseLifecycleStep({ kind: "account_lifecycle", payload: { operation: "reset", user_id: " " } })).toBeNull();
    expect(parseLifecycleStep(null)).toBeNull();
  });
});

describe("runAccountLifecycleStep — owner binding and auth", () => {
  it("refuses to run for anyone but the owner who tapped", async () => {
    const d = deps({ currentUid: "uid-other" });
    const out = await runAccountLifecycleStep(step("delete"), d);
    expect(out).toEqual({
      status: "failed",
      payload: { outcome: "auth_failed", operation: "delete", reason: "owner_mismatch" },
    });
    expect(d.calls).toEqual([]);
  });

  it("refuses when signed out", async () => {
    const d = deps({ currentUid: null });
    const out = await runAccountLifecycleStep(step("reset"), d);
    expect(out.payload.outcome).toBe("auth_failed");
    expect(d.calls).toEqual([]);
  });

  it("hands the held vault token to auth resolution", async () => {
    const d = deps();
    await runAccountLifecycleStep(step("reset"), d);
    expect(d.resolveAuth).toHaveBeenCalledWith({ userId: UID, existingVaultOwnerToken: "HCT:held" });
  });

  it("needs_unlock is an honest handoff: nothing runs, status ok", async () => {
    const d = deps({
      resolveAuth: vi.fn(async () => ({ kind: "needs_unlock" as const, hasVault: true as const })),
    });
    const out = await runAccountLifecycleStep(step("delete"), d);
    expect(out).toEqual({ status: "ok", payload: { outcome: "needs_unlock", operation: "delete" } });
    expect(d.executeDeletion).not.toHaveBeenCalled();
  });

  it("a failed auth resolution runs nothing", async () => {
    const d = deps({ resolveAuth: vi.fn(async () => { throw new Error("boom"); }) });
    const out = await runAccountLifecycleStep(step("reset"), d);
    expect(out.payload).toEqual({ outcome: "auth_failed", operation: "reset", reason: "auth_resolution_failed" });
    expect(d.resetAccount).not.toHaveBeenCalled();
  });
});

describe("runAccountLifecycleStep — reset", () => {
  it("runs cleanup only after a backend-confirmed reset, then reports reset", async () => {
    const d = deps();
    const out = await runAccountLifecycleStep(step("reset"), d);
    expect(out).toEqual({ status: "ok", payload: { outcome: "reset", operation: "reset" } });
    expect(d.calls).toEqual(["resolveAuth", "resetAccount", "afterReset"]);
  });

  it("a 200 without the reset flag is unknown, and no cleanup runs", async () => {
    const d = deps({ resetAccount: vi.fn(async () => ({ success: true })) });
    const out = await runAccountLifecycleStep(step("reset"), d);
    expect(out.payload.outcome).toBe("unknown");
    expect(d.afterReset).not.toHaveBeenCalled();
  });

  it("an explicit failure is not_reset, and no cleanup runs", async () => {
    const d = deps({ resetAccount: vi.fn(async () => ({ success: false })) });
    const out = await runAccountLifecycleStep(step("reset"), d);
    expect(out.payload.outcome).toBe("not_reset");
    expect(d.afterReset).not.toHaveBeenCalled();
  });

  it("a lost response is unknown, never not_reset — the server decides", async () => {
    const d = deps({ resetAccount: vi.fn(async () => { throw new Error("network"); }) });
    const out = await runAccountLifecycleStep(step("reset"), d);
    expect(out).toEqual({
      status: "failed",
      payload: { outcome: "unknown", operation: "reset", reason: "reset_request_failed" },
    });
    expect(d.afterReset).not.toHaveBeenCalled();
  });

  it("a confirmed reset whose local cleanup throws is still reported as reset", async () => {
    const d = deps({ afterReset: vi.fn(async () => { throw new Error("storage"); }) });
    const out = await runAccountLifecycleStep(step("reset"), d);
    expect(out.payload.outcome).toBe("reset");
  });
});

describe("runAccountLifecycleStep — delete", () => {
  it("reports deleted before the sign-out that may tear the session down", async () => {
    const d = deps();
    const out = await runAccountLifecycleStep(step("delete"), d);
    expect(out).toEqual({ status: "ok", payload: { outcome: "deleted", operation: "delete" } });
    expect(d.executeDeletion).toHaveBeenCalledWith({ userId: UID, vaultOwnerToken: "HCT:held" });
    await Promise.resolve();
    expect(d.afterDelete).toHaveBeenCalledWith(UID);
  });

  it("the exact external-resource 409 is blocked_external, with status ok (nothing deleted)", async () => {
    const d = deps({
      executeDeletion: vi.fn(async () => {
        throw new ApiError("blocked", 409, {
          code: ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE,
        });
      }),
    });
    const out = await runAccountLifecycleStep(step("delete"), d);
    expect(out).toEqual({ status: "ok", payload: { outcome: "blocked_external", operation: "delete" } });
    expect(d.afterDelete).not.toHaveBeenCalled();
  });

  it("an uncertain outcome is unknown and never retried here", async () => {
    const d = deps({
      executeDeletion: vi.fn(async () => {
        throw new AccountDeletionOutcomeUncertainError(new Error("lost"));
      }),
    });
    const out = await runAccountLifecycleStep(step("delete"), d);
    expect(out).toEqual({
      status: "failed",
      payload: { outcome: "unknown", operation: "delete", reason: "deletion_outcome_uncertain" },
    });
    expect(d.executeDeletion).toHaveBeenCalledTimes(1);
    expect(d.afterDelete).not.toHaveBeenCalled();
  });

  it("any other failure is failed, and no sign-out runs", async () => {
    const d = deps({ executeDeletion: vi.fn(async () => { throw new ApiError("down", 503); }) });
    const out = await runAccountLifecycleStep(step("delete"), d);
    expect(out.payload.outcome).toBe("failed");
    expect(d.afterDelete).not.toHaveBeenCalled();
  });
});
