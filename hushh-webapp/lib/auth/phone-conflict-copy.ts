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
  const rawCode = String(backendCode ?? (error as { code?: unknown })?.code ?? "").replace(/^auth\//, "");
  const isTransportFailure =
    !rawCode &&
    ((error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) ||
      (error as { name?: unknown })?.name === "TimeoutError");
  const code = isTransportFailure ? "network-request-failed" : rawCode;
  if (code === "PHONE_TRANSFER_CONFIRMATION_REQUIRED" || code === "PHONE_SESSION_ACCOUNT_CONFLICT") return "This number is linked to another account. Choose how to continue.";
  if (code === "phone_verification_busy") return "Phone verification is finishing. Wait a moment and try again.";
  if (code === "phone-link-upgrade-required") return "Update the app to verify a phone number.";
  if (code === "AUTH_INDEPENDENT_SIGN_IN_REQUIRED") return "Sign in again with your existing email or sign-in provider, then retry phone verification.";
  if (code === "PHONE_TRANSFER_IN_PROGRESS") return "Finishing phone transfer. Check progress again.";
  // Nonproduction lanes on the shared production sign-in can never move a number; recovery needs that account's sign-in.
  if (code === "PHONE_TRANSFER_SHARED_AUTH_UNAVAILABLE") return "Moving a number isn't available in this environment. Delete your previous account or use a different number.";
  if (code === "PHONE_TRANSFER_REAL_SMS_REQUIRED") return "A shared test code cannot transfer a number. Use fresh real SMS verification.";
  if (code === "PHONE_ALREADY_VERIFIED" || code === "PHONE_TEST_NUMBER_IN_USE") return "This phone number is verified for another account. Sign in to that account or use a different number.";
  if (code === "PHONE_VERIFICATION_CHANGED" || code === "phone-verification-required") return "Request a new verification code before trying again.";
  if (["IDENTITY_PROVIDER_UNAVAILABLE", "PHONE_IDENTITY_SAVE_FAILED", "DATABASE_UNAVAILABLE", "PHONE_TEST_START_UNAVAILABLE"].includes(code)) return "Phone verification is temporarily unavailable. Wait a moment and retry.";
  if (["credential-already-in-use", "phone-number-already-exists"].includes(code)) return PHONE_CONFLICT_COPY.inApp;
  if (code === "phone-already-linked-to-current-user") return "This phone number is already linked to your account.";
  if (code === "phone-replace-required") return "Use Change phone number to replace the current number.";
  if (code === "session_changed" || code === "PHONE_VERIFICATION_ACCOUNT_CHANGED") return "Your signed-in account changed. Start phone verification again.";
  if (code === "network-request-failed") return "Phone verification could not reach the network. Check your connection and try again.";
  if (["captcha-check-failed", "invalid-app-credential", "unauthorized-domain", "app-not-authorized", "missing-client-identifier"].includes(code)) return "Browser security verification could not complete for this domain. Refresh the page and try again.";
  if (code === "recaptcha-incomplete") return "Security verification did not complete. Complete the verification challenge if prompted, or refresh the page and try again.";
  if (code === "quota-exceeded" || code === "billing-not-enabled") return "SMS verification has reached its temporary limit right now. Wait a bit or use an approved test number.";
  if (code === "code-expired") return "This verification code has expired. Please request a new code.";
  if (code === "invalid-verification-code" || code === "UAT_PHONE_TEST_INVALID_CODE") return "That code isn't right. Check it and try again.";
  if (code === "invalid-phone-number") return "Enter a valid phone number with your country code and try again.";
  if (code === "operation-not-allowed") return "Phone verification is temporarily unavailable for this configuration. Please try again later.";
  if (code === "sms-region-not-allowed") return "SMS verification is not currently available for this country or region.";
  if (code === "phone-verification-start-timeout") return "Sending the verification code took too long. Request a new code.";
  if (code === "requires-recent-login") return "For security, sign in again before changing your phone number.";
  if (code === "too-many-requests") return "Too many attempts. Wait a moment before trying again.";
  return fallback;
}
