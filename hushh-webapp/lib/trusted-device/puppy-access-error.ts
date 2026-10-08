import { OwnerPodError } from "@/lib/services/owner-pod-crypto";

const CONNECTION_FAILURES = new Map([
  ["HUB_SIGNATURE_INVALID", "Your pod connection could not be verified."],
  ["HUB_SIGNING_KEY_UNKNOWN", "Your pod's verification key is unavailable."],
  ["HUB_VERIFICATION_KEYS_UNAVAILABLE", "Pod verification is temporarily unavailable."],
  ["ENDPOINT_VERSION_REGRESSION", "The hub returned an older pod connection record."],
  ["ENDPOINT_CHANGED_WITHOUT_VERSION_BUMP", "Your pod connection changed without a new version."],
  ["ENDPOINT_OWNER_OR_ENVIRONMENT_CHANGED", "The pod connection does not match this account."],
  ["ENDPOINT_MALFORMED", "The hub returned an incomplete pod connection record."],
  ["WEBCRYPTO_UNAVAILABLE", "This browser cannot securely connect to your pod."],
  ["STORAGE_BLOCKED", "Another tab is blocking the saved pod connection. Close that tab and retry."],
  ["STORAGE_UNAVAILABLE", "Browser storage is unavailable for your pod connection."],
  ["STORAGE_READ_FAILED", "The browser could not read its saved pod connection."],
  ["POD_CHALLENGE_REFUSED", "Your pod refused the secure connection request."],
  ["POD_ADMISSION_REFUSED", "Your pod did not admit this browser."],
  ["BINDING_UNAVAILABLE", "This browser's pod authorization is unavailable."],
]);

/** Only locally authored labels and references may reach the owner-facing toast. */
export function puppyAccessError(error: unknown, enabling: boolean): string {
  if (error instanceof OwnerPodError) {
    const code = error.code.split(":")[0] ?? "";
    const label = CONNECTION_FAILURES.get(code);
    if (label) return `${label} Reference: ${code}.`;
  }
  return enabling
    ? "Could not enable Puppy. Check your pod connection and try again."
    : "Withdrawal could not be confirmed. Check access and retry.";
}
