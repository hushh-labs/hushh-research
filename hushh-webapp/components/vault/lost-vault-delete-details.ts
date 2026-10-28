import { apiErrorCode } from "@/lib/services/api-client";
import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";
import { getCountryCallingCode, isSupportedCountry, type CountryCode } from "libphonenumber-js/core";
import mobileMetadata from "libphonenumber-js/mobile/metadata";

// Use the same numbering plans as the existing phone-entry UI, including NANP.
export const DELETION_PHONE_COUNTRIES = COUNTRY_PHONE_OPTIONS.filter((option) =>
  isSupportedCountry(option.value as CountryCode, mobileMetadata),
).map((option) => ({
  ...option,
  dialCode: `+${getCountryCallingCode(option.value as CountryCode, mobileMetadata)}`,
}));
export function identityMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "identity_cancelled")
    return "Sign-in check cancelled. Try again.";
  if (code === "identity_popup_blocked")
    return "Allow the sign-in window, then try again.";
  if (code === "identity_initialization_not_ready")
    return "Google sign-in is getting ready. Try again in a moment.";
  if (code === "identity_timeout")
    return "Your sign-in check timed out. Close the sign-in window and try again.";
  if (code === "native_identity_unavailable")
    return "Use One on the web, or contact support.";
  if (code === "session_changed" || code === "identity_mismatch")
    return "Your account changed. Sign in again.";
  return "We could not verify you. Try again.";
}

export function phoneMessage(error: unknown, sending: boolean): string {
  switch (apiErrorCode(error)) {
    case "ACCOUNT_DELETE_PHONE_MISMATCH":
      return "That number does not match your linked phone. Check the full number and country code.";
    case "ACCOUNT_DELETE_PHONE_INVALID":
      return "Enter a valid mobile number and country code.";
    case "ACCOUNT_DELETE_PHONE_BINDING_CONFLICT":
      return "Your linked phone records disagree. No code was sent. Contact support.";
    case "ACCOUNT_DELETE_METHOD_UNAVAILABLE":
      return "Your account’s phone changed. Go back and verify your account again.";
    case "ACCOUNT_DELETE_VERIFICATION_UNAVAILABLE":
      return "We could not check your linked phone. Try again.";
  }
  const code = String((error as { code?: unknown })?.code ?? "").replace(
    /^auth\//,
    "",
  );
  if (code === "code-expired" || code === "session-expired")
    return "This code expired. Request a new code.";
  if (code === "invalid-verification-code")
    return "That code is incorrect. Check it and try again.";
  if (code === "too-many-requests")
    return "Too many attempts. Wait a moment before requesting another code.";
  return sending
    ? "We could not send the code. Try again."
    : "That code did not work. Try again or request a new code.";
}
