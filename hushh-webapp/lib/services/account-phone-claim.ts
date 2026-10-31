import { ApiService, type AccountIdentity } from "./api-service";
import { ApiError, apiErrorCode } from "./api-client";

type TransferProof = { token: string; transferId?: string; submitted?: boolean };
export async function claimPhoneForOwner(idToken: string, phoneIdToken: string, ownerId: string, isCurrent: () => boolean): Promise<AccountIdentity | null> {
    const response = await ApiService.claimAccountPhone(phoneIdToken, idToken, ownerId);
    if (!isCurrent()) return null;
    const identity = response.identity ?? null;
    if (identity?.user_id !== ownerId) {
      throw new Error("Phone verification could not be completed for this account.");
    }
    return identity;
}

export async function transferPhoneForOwner(idToken: string, proof: TransferProof, ownerId: string, assertCurrent: () => void): Promise<AccountIdentity> {
    if (!proof.transferId) {
      const prepared = await ApiService.phoneTransferRequest<{ transfer_id: string }>("prepare", idToken,
        { phone_id_token: proof.token, expected_user_id: ownerId });
      assertCurrent(); proof.transferId = prepared.transfer_id;
    }
    let result: { identity: AccountIdentity; transfer_status: "completed" | "in_progress" | "not_started" | "action_required" };
    try {
      if (proof.submitted) {
        result = await ApiService.phoneTransferRequest(proof.transferId, idToken);
      } else {
        proof.submitted = true;
        result = await ApiService.phoneTransferRequest("confirm", idToken,
          { phone_id_token: proof.token, expected_user_id: ownerId, transfer_id: proof.transferId, confirmed: true });
      }
    } catch (error) {
      assertCurrent();
      if (error instanceof ApiError && error.status === 403 &&
          apiErrorCode(error) === "PHONE_TRANSFER_SHARED_AUTH_UNAVAILABLE") throw error;
      // Once dispatched, a lost response is an unknown outcome. Only status
      // readback may unlock another attempt; never blindly replay confirmation.
      throw new ApiError("Finishing phone transfer. Check progress again.", 503, { code: "PHONE_TRANSFER_IN_PROGRESS" });
    }
    if (result.transfer_status === "not_started") {
      proof.submitted = false;
      throw new ApiError("Transfer did not start. Request a fresh SMS code and try again.", 409, { code: "PHONE_TRANSFER_STALE" });
    }
    assertCurrent();
    if (result.transfer_status === "action_required") throw new ApiError("Phone transfer needs a security check. Contact one@hushh.ai and check progress again.", 503, { code: "PHONE_TRANSFER_ACTION_REQUIRED" });
    if (result.transfer_status !== "completed") throw new ApiError("Finishing phone transfer. Your accounts and information are safe. Check progress again.", 503,
      { code: "PHONE_TRANSFER_IN_PROGRESS" });
    if (result.identity?.user_id !== ownerId || result.identity.phone_verified !== true)
      throw new Error("Phone transfer could not be confirmed. Please retry.");
    return result.identity;
}
