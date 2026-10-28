import type { User } from "firebase/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmLinkedDeletion, type LinkedDeletionPorts } from "@/lib/auth/phone-linked-deletion";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { PhoneRecoveryService } from "@/lib/services/phone-recovery-service";

const user = { uid: "owner" } as User;
const input = { operationId: "op-1", phoneNumber: "+16505550101" };
const verified = { user_id: "owner", phone_number: "+16505550101", phone_verified: true };

function ports(retained: { token: string; userId: string; epoch: number } | null = { token: "sms-proof", userId: "owner", epoch: 3 }) {
  return { user: () => user, retained: () => retained, requireOwner: vi.fn(), finalize: vi.fn() } satisfies LinkedDeletionPorts;
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("confirmLinkedDeletion", () => {
  it("reads a lost response back instead of re-sending the deletion, then claims with the same proof", async () => {
    vi.useFakeTimers();
    const confirm = vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockRejectedValue(new TypeError("Failed to fetch"));
    const status = vi.spyOn(PhoneRecoveryService, "linkedDeletionStatus").mockResolvedValue({ operation_id: "op-1", state: "admitted" });
    const claim = vi.spyOn(AccountIdentityService, "claimCurrentUserPhone").mockResolvedValue(verified as never);
    const owner = ports();
    const result = confirmLinkedDeletion(input, owner);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe(user);
    expect(confirm).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledExactlyOnceWith(user, "sms-proof");
    expect(owner.requireOwner).toHaveBeenCalledWith("owner", 3);
    expect(owner.finalize).toHaveBeenCalledExactlyOnceWith(user);
  });

  it("keeps a lost response that still reads back pending unconfirmed, never refused", async () => {
    vi.useFakeTimers();
    vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(PhoneRecoveryService, "linkedDeletionStatus").mockResolvedValue({ operation_id: "op-1", state: "pending" });
    const claim = vi.spyOn(AccountIdentityService, "claimCurrentUserPhone");
    const result = confirmLinkedDeletion(input, ports()).catch(error => error);
    await vi.runAllTimersAsync();
    expect(apiErrorCode(await result)).toBe("PHONE_LINKED_DELETION_SUPPORT_REQUIRED");
    expect(claim).not.toHaveBeenCalled();
  });

  it("never reports a deletion when no holder was found and the claim failed", async () => {
    vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockResolvedValue({ operation_id: "op-1", state: "refused", code: "PHONE_LINKED_ACCOUNT_NOT_FOUND" });
    vi.spyOn(AccountIdentityService, "claimCurrentUserPhone").mockRejectedValue(new ApiError("taken", 409, { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" }));
    const failure = await confirmLinkedDeletion(input, ports()).catch(error => error);
    expect(apiErrorCode(failure)).toBe("PHONE_LINKED_ACCOUNT_CHANGED");
    expect(failure.message).not.toMatch(/deleted/i);
  });

  it.each(["PHONE_LINKED_ACCOUNT_PROTECTED", "PHONE_LINKED_DELETION_STALE"])("never claims after a %s refusal", async code => {
    vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockResolvedValue({ operation_id: "op-1", state: "refused", code });
    const claim = vi.spyOn(AccountIdentityService, "claimCurrentUserPhone");
    const owner = ports();
    const failure = await confirmLinkedDeletion(input, owner).catch(error => error);
    expect(apiErrorCode(failure)).toBe(code);
    expect(claim).not.toHaveBeenCalled();
    expect(owner.finalize).not.toHaveBeenCalled();
  });

  it("requires a proof for real numbers and reports an admitted deletion whose claim failed", async () => {
    const confirm = vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockResolvedValue({ operation_id: "op-1", state: "admitted" });
    expect(apiErrorCode(await confirmLinkedDeletion(input, ports(null)).catch(error => error))).toBe("PHONE_LINKED_PROOF_REQUIRED");
    expect(confirm).not.toHaveBeenCalled();
    vi.spyOn(AccountIdentityService, "claimCurrentUserPhone").mockRejectedValue(new ApiError("taken", 409, { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" }));
    const owner = ports();
    const failure = await confirmLinkedDeletion(input, owner).catch(error => error);
    expect(apiErrorCode(failure)).toBe("PHONE_LINKED_CLAIM_REQUIRED");
    expect(owner.finalize).not.toHaveBeenCalled();
  });
});
