import { describe, expect, it } from "vitest";

import {
  ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE,
  AccountDeletionOutcomeUncertainError,
} from "@/lib/flows/delete-account";
import {
  AccountResetNotConfirmedError,
  classifyDeletionError,
  lifecycleOutcomeToVoice,
  marketplaceOutcomeToVoice,
  resetErrorMessage,
  resolveMarketplaceTarget,
  resolveResetOutcome,
  supportOutcomeToVoice,
} from "@/lib/profile/profile-action-outcomes";
import { ApiError } from "@/lib/services/api-client";

describe("resolveResetOutcome", () => {
  it("is reset only when both flags say so", () => {
    expect(resolveResetOutcome({ success: true, account_reset: true })).toBe("reset");
  });

  it("is not_reset on an explicit failure", () => {
    expect(resolveResetOutcome({ success: false })).toBe("not_reset");
    expect(resolveResetOutcome({ success: false, account_reset: true })).toBe("not_reset");
  });

  it("is unknown when a 200 carries no reset flag, a false flag, or is malformed", () => {
    // Graph observation 5: the page awaited the service and ran success
    // cleanup regardless. A resolved promise is not a reset.
    expect(resolveResetOutcome({ success: true })).toBe("unknown");
    expect(resolveResetOutcome({ success: true, account_reset: false })).toBe("unknown");
    expect(resolveResetOutcome(null)).toBe("unknown");
    expect(resolveResetOutcome(undefined)).toBe("unknown");
    expect(resolveResetOutcome("ok" as unknown as { success: boolean })).toBe("unknown");
  });

  it("the deletion probe's flag is not reset evidence", () => {
    expect(resolveResetOutcome({ success: true, account_deleted: true })).toBe("unknown");
  });
});

describe("resetErrorMessage", () => {
  it("distinguishes not-reset from unknown, and keeps the generic fallback", () => {
    expect(resetErrorMessage(new AccountResetNotConfirmedError("not_reset"))).toBe(
      "Your account was not reset.",
    );
    expect(resetErrorMessage(new AccountResetNotConfirmedError("unknown"))).toBe(
      "We couldn't confirm whether your account was reset.",
    );
    expect(resetErrorMessage(new Error("boom"))).toBe("Failed to reset account. Please try again.");
  });
});

describe("resolveMarketplaceTarget", () => {
  it("treats a stated intent as a target state, compared at execution time", () => {
    expect(resolveMarketplaceTarget(true, false)).toEqual({ target: true, alreadyThere: false });
    expect(resolveMarketplaceTarget(true, true)).toEqual({ target: true, alreadyThere: true });
    expect(resolveMarketplaceTarget("on", false)).toEqual({ target: true, alreadyThere: false });
    expect(resolveMarketplaceTarget("off", true)).toEqual({ target: false, alreadyThere: false });
  });

  it("a bare toggle has no target and never counts as already there", () => {
    expect(resolveMarketplaceTarget(undefined, true)).toEqual({ target: null, alreadyThere: false });
    expect(resolveMarketplaceTarget("maybe", true)).toEqual({ target: null, alreadyThere: false });
  });
});

describe("marketplaceOutcomeToVoice", () => {
  it("narrates the stored value, not the requested one", () => {
    expect(marketplaceOutcomeToVoice({ kind: "set", value: true }).status).toBe("succeeded");
    expect(marketplaceOutcomeToVoice({ kind: "set", value: false }).summary).toMatch(/hidden/);
    expect(marketplaceOutcomeToVoice({ kind: "failed" }).status).toBe("failed");
    expect(marketplaceOutcomeToVoice({ kind: "no_user" }).status).toBe("blocked");
  });
});

describe("supportOutcomeToVoice", () => {
  it("only an accepted submission is 'sent'", () => {
    expect(supportOutcomeToVoice({ kind: "accepted" })).toEqual({
      status: "succeeded",
      summary: "Sent that to support.",
    });
  });

  it("every early return names why nothing was sent", () => {
    // Graph observation 6: the wrapper said "sent" after the helper returned
    // early on validation/offline or caught an error.
    for (const kind of ["too_short", "invalid_reply_email", "offline", "busy", "no_user"] as const) {
      const out = supportOutcomeToVoice({ kind });
      expect(out.status).toBe("blocked");
      expect(out.summary).not.toMatch(/sent that/i);
    }
    for (const kind of ["rejected", "failed"] as const) {
      const out = supportOutcomeToVoice({ kind });
      expect(out.status).toBe("failed");
      expect(out.summary).toMatch(/still in the form/);
    }
  });
});

describe("classifyDeletionError", () => {
  it("keeps the exact external-resource 409 distinct from other 409s and transport errors", () => {
    const blocked = new ApiError("blocked", 409, {
      code: ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE,
    });
    expect(classifyDeletionError(blocked)).toBe("blocked_external");
    expect(classifyDeletionError(new ApiError("other", 409, { code: "SOMETHING_ELSE" }))).toBe("failed");
    expect(classifyDeletionError(new ApiError("down", 503))).toBe("failed");
    expect(classifyDeletionError(new Error("network"))).toBe("failed");
  });

  it("an uncertain outcome is unknown, never failed", () => {
    expect(classifyDeletionError(new AccountDeletionOutcomeUncertainError(new Error("lost")))).toBe(
      "unknown",
    );
  });
});

describe("lifecycleOutcomeToVoice", () => {
  it("never says deleted unless the outcome is deleted", () => {
    for (const outcome of ["needs_unlock", "auth_failed", "blocked_external", "failed", "unknown"] as const) {
      expect(lifecycleOutcomeToVoice(outcome).status).not.toBe("succeeded");
    }
    expect(lifecycleOutcomeToVoice("deleted").status).toBe("succeeded");
  });

  it("unknown tells the person to check rather than retry, and blocked names nothing was deleted", () => {
    expect(lifecycleOutcomeToVoice("unknown").summary).toMatch(/couldn't confirm/);
    expect(lifecycleOutcomeToVoice("blocked_external").summary).toMatch(/Nothing was deleted/);
    expect(lifecycleOutcomeToVoice("failed").summary).toMatch(/Nothing was deleted/);
  });
});
