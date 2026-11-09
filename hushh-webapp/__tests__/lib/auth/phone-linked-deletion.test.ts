import type { User } from "firebase/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmLinkedDeletion, linkedDeletionMessage, linkedDeletionNeedsFreshProof, type LinkedDeletionPorts } from "@/lib/auth/phone-linked-deletion";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { apiErrorCode } from "@/lib/services/api-client";
import { PhoneRecoveryService } from "@/lib/services/phone-recovery-service";

const user = { uid: "owner" } as User;
const input = { operationId: "op-1", phoneNumber: "+16505550101" };
const verified = { user_id: "owner", phone_number: "+16505550101", phone_verified: true };

function ports(retained: { token: string; userId: string; epoch: number } | null = { token: "sms-proof", userId: "owner", epoch: 3 }) {
  return { user: () => user, retained: () => retained, requireOwner: vi.fn(), releaseProof: vi.fn() } satisfies LinkedDeletionPorts;
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("confirmLinkedDeletion", () => {
  it("reads a lost response without re-sending deletion or claiming with the previous UID proof", async () => {
    vi.useFakeTimers();
    const confirm = vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockRejectedValue(new TypeError("Failed to fetch"));
    const status = vi.spyOn(PhoneRecoveryService, "linkedDeletionStatus").mockResolvedValue({ operation_id: "op-1", state: "admitted" });
    const claim = vi.spyOn(AccountIdentityService, "claimCurrentUserPhone").mockResolvedValue(verified as never);
    const owner = ports();
    const result = confirmLinkedDeletion(input, owner).catch(error => error);
    await vi.runAllTimersAsync();
    const failure = await result;
    expect(apiErrorCode(failure)).toBe("PHONE_LINKED_CLAIM_REQUIRED");
    expect(failure.message).toContain("Deletion requested.");
    expect(failure.message).not.toMatch(/was deleted/i);
    expect(confirm).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
    expect(owner.requireOwner).toHaveBeenCalledWith("owner", 3);
    expect(owner.releaseProof).toHaveBeenCalledOnce();
  });

  it("refuses a shared test code locally and never sends it as deletion authority", async () => {
    const confirm = vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion");
    const claim = vi.spyOn(AccountIdentityService, "claimCurrentUserPhone");
    const owner = ports();
    const failure = await confirmLinkedDeletion({ ...input, testCode: "123456" }, owner).catch(error => error);
    expect(apiErrorCode(failure)).toBe("PHONE_LINKED_DELETION_REAL_SMS_REQUIRED");
    expect(linkedDeletionNeedsFreshProof(apiErrorCode(failure))).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(owner.releaseProof).not.toHaveBeenCalled();
  });

  it("does not release a newer same-owner attempt after a late deletion admission", async () => {
    let admit!: (value: { operation_id: string; state: "admitted" }) => void;
    vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockReturnValue(new Promise(resolve => { admit = resolve; }));
    const owner = ports();
    const result = confirmLinkedDeletion(input, owner).catch(error => error);
    expect(owner.requireOwner).toHaveBeenCalledOnce();
    owner.requireOwner.mockImplementation(() => { throw new Error("Phone attempt changed"); });
    admit({ operation_id: "op-1", state: "admitted" });
    expect((await result).message).toBe("Phone attempt changed");
    expect(owner.releaseProof).not.toHaveBeenCalled();
  });

  it("keeps a lost response that still reads back pending unconfirmed, never refused", async () => {
    vi.useFakeTimers();
    vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(PhoneRecoveryService, "linkedDeletionStatus").mockResolvedValue({ operation_id: "op-1", state: "pending" });
    const claim = vi.spyOn(AccountIdentityService, "claimCurrentUserPhone");
    const owner = ports();
    const result = confirmLinkedDeletion(input, owner).catch(error => error);
    await vi.runAllTimersAsync();
    expect(apiErrorCode(await result)).toBe("PHONE_LINKED_DELETION_SUPPORT_REQUIRED");
    expect(claim).not.toHaveBeenCalled();
    // The proof stays for "Check again" on the same operation; nothing is released yet.
    expect(owner.releaseProof).not.toHaveBeenCalled();
  });

  it("requires fresh same-owner verification when no holder was found, without calling the number free", async () => {
    vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockResolvedValue({ operation_id: "op-1", state: "refused", code: "PHONE_LINKED_ACCOUNT_NOT_FOUND" });
    const claim = vi.spyOn(AccountIdentityService, "claimCurrentUserPhone");
    const owner = ports();
    const failure = await confirmLinkedDeletion(input, owner).catch(error => error);
    expect(apiErrorCode(failure)).toBe("PHONE_LINKED_ACCOUNT_NOT_FOUND");
    expect(failure.message).not.toMatch(/deleted|expired|no other account is using/i);
    expect(failure.message).toContain("an earlier deletion may still be finishing");
    expect(claim).not.toHaveBeenCalled();
    expect(owner.releaseProof).toHaveBeenCalledOnce();
  });

  it("keeps requested, not-found and expired outcomes distinct and never reports erasure", () => {
    const requested = linkedDeletionMessage("PHONE_LINKED_CLAIM_REQUIRED");
    const notFound = linkedDeletionMessage("PHONE_LINKED_ACCOUNT_NOT_FOUND");
    const expired = linkedDeletionMessage("PHONE_LINKED_DELETION_PROOF_REQUIRED");
    expect(new Set([requested, notFound, expired]).size).toBe(3);
    for (const message of [requested, notFound, expired]) expect(message).not.toMatch(/was deleted|erased|freed/i);
    expect(expired).toMatch(/expired/i);
    // Decoding the proof fails before any write, so the same review may retry.
    expect(linkedDeletionNeedsFreshProof("PHONE_PROOF_SERVICE_UNAVAILABLE")).toBe(false);
    expect(linkedDeletionNeedsFreshProof("PHONE_LINKED_ACCOUNT_NOT_FOUND")).toBe(true);
  });

  it.each(["PHONE_LINKED_ACCOUNT_PROTECTED", "PHONE_LINKED_DELETION_STALE"])("never claims after a %s refusal", async code => {
    vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockResolvedValue({ operation_id: "op-1", state: "refused", code });
    const claim = vi.spyOn(AccountIdentityService, "claimCurrentUserPhone");
    const owner = ports();
    const failure = await confirmLinkedDeletion(input, owner).catch(error => error);
    expect(apiErrorCode(failure)).toBe(code);
    expect(claim).not.toHaveBeenCalled();
    expect(owner.releaseProof).not.toHaveBeenCalled();
  });

  it("requires a proof for real numbers and never links a merely admitted deletion", async () => {
    const confirm = vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockResolvedValue({ operation_id: "op-1", state: "admitted" });
    const claim = vi.spyOn(AccountIdentityService, "claimCurrentUserPhone");
    expect(apiErrorCode(await confirmLinkedDeletion(input, ports(null)).catch(error => error))).toBe("PHONE_LINKED_PROOF_REQUIRED");
    expect(confirm).not.toHaveBeenCalled();
    const owner = ports();
    const failure = await confirmLinkedDeletion(input, owner).catch(error => error);
    expect(apiErrorCode(failure)).toBe("PHONE_LINKED_CLAIM_REQUIRED");
    expect(claim).not.toHaveBeenCalled();
    expect(owner.releaseProof).toHaveBeenCalledOnce();
  });
});
