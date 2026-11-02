/** Keep phone ownership conflicts in-app; no speculative account email is sent. */
export const PHONE_CONFLICT_COPY = {
  inApp: "That number is already on another Hussh account. Sign in to that account or use a different number.",
} as const;

export function isPhoneOwnershipConflict(error: unknown, backendCode: string | null = null): boolean {
  const code = String(backendCode ?? (error as { code?: unknown })?.code ?? "").replace(/^auth\//, "");
  return ["PHONE_ALREADY_VERIFIED", "PHONE_TEST_NUMBER_IN_USE", "PHONE_SESSION_ACCOUNT_CONFLICT",
    "PHONE_TRANSFER_CONFIRMATION_REQUIRED", "PHONE_TRANSFER_SHARED_AUTH_UNAVAILABLE",
    "credential-already-in-use", "phone-number-already-exists"].includes(code);
}

export function resolvePhoneFailureMessage(error: unknown, fallback: string, backendCode: string | null = null): string {
  const code = String(backendCode ?? (error as { code?: unknown })?.code ?? "").replace(/^auth\//, "");
  if (["PHONE_TRANSFER_CONFIRMATION_REQUIRED", "PHONE_SESSION_ACCOUNT_CONFLICT", "PHONE_TRANSFER_SHARED_AUTH_UNAVAILABLE", "PHONE_TRANSFER_REAL_SMS_REQUIRED", "PHONE_ALREADY_VERIFIED", "PHONE_TEST_NUMBER_IN_USE"].includes(code)) return PHONE_CONFLICT_COPY.inApp;
  if (code === "PHONE_TRANSFER_IN_PROGRESS") return "Finishing phone transfer. Check progress again.";
  if (code === "PHONE_VERIFICATION_CHANGED" || code === "phone-verification-required") return "Request a new verification code before trying again.";
  if (["IDENTITY_PROVIDER_UNAVAILABLE", "PHONE_IDENTITY_SAVE_FAILED", "DATABASE_UNAVAILABLE"].includes(code)) return "Phone verification is temporarily unavailable. Wait a moment and retry.";
  if (["credential-already-in-use", "phone-number-already-exists"].includes(code)) return PHONE_CONFLICT_COPY.inApp;
  if (code === "code-expired") return "This verification code has expired. Please request a new code.";
  if (code === "invalid-verification-code" || code === "UAT_PHONE_TEST_INVALID_CODE") return "That code isn't right. Check it and try again.";
  if (code === "requires-recent-login") return "For security, sign in again before changing your phone number.";
  if (code === "too-many-requests") return "Too many attempts. Wait a moment before trying again.";
  return fallback;
}
