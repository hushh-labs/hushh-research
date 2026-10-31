import { ApiError, apiErrorCode } from "@/lib/services/api-client";

/** Parse identity responses without hiding strict persistence failures or publishing rejected claims. */
export async function readAccountIdentityResponse<T>(response: Response, requireSuccess = false): Promise<T | null> {
  if (!response.ok) {
    if (!requireSuccess) return null;
    const payload: unknown = await response.json().catch(() => undefined);
    const code = apiErrorCode(new ApiError("", response.status, payload)) ?? "PHONE_IDENTITY_SAVE_FAILED";
    const message = code === "PHONE_ALREADY_VERIFIED"
      ? "This phone number is already verified for another account. Sign in to that account or use a different phone number."
      : code === "PHONE_VERIFICATION_CHANGED"
        ? "The verified phone changed. Request a new code to verify this number."
        : "Phone verification could not be saved right now. Wait a moment and retry.";
    // Only stable classification crosses this boundary; arbitrary diagnostics stay out of UI errors.
    throw new ApiError(message, response.status, { detail: { code } });
  }
  const payload = (await response.json().catch(() => null)) as { identity?: T | null } | null;
  return payload?.identity ?? null;
}
