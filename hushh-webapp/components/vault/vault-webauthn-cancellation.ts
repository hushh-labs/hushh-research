// A passkey cancellation is a normal user decision, not an application
// failure. Keep it in the credential surface so the user can choose a
// fallback without a disappearing toast or an automatic second ceremony.
//
// A bare "cancel" or "cancelled" substring is too broad — it matches
// aborted fetches, cancelled analytics, and other non-WebAuthn noise.
// Require at least one WebAuthn-specific context word alongside the
// cancellation signal so we only silence real passkey dismissals.
const WEBAUTHN_CANCEL_CONTEXT = [
  "passkey",
  "authentication",
  "credential",
  "webauthn",
  "webauth",
  "user",
  "operation",
  "request",
  "prompt",
  "securitykey",
  "security key",
];
export function isWebAuthnCancellationError(value: unknown): boolean {
  const error = value as { name?: unknown; message?: unknown; code?: unknown } | null;
  const name = typeof error?.name === "string" ? error.name.toLowerCase() : "";
  const code = typeof error?.code === "string" ? error.code.toLowerCase() : "";
  const message =
    typeof value === "string"
      ? value.toLowerCase()
      : typeof error?.message === "string"
        ? error.message.toLowerCase()
        : "";

  // AbortError / NotAllowedError from navigator.credentials.get are the
  // two most reliable signals — they are DOMException names, not strings.
  if (name === "aborterror" || name === "notallowederror") return true;

  // Structured AbortSignal cancellation codes used by some frameworks.
  if (code.includes("cancel") || code.includes("abort")) return true;

  // For substring matches, require a WebAuthn context word near the cancel
  // term so we don't misclassify unrelated cancellations. Match both
  // British "cancelled" and American "canceled" spellings.
  const hasCancel = (text: string): boolean =>
    /cancell?ed?/i.test(text) || /timed out or was not allowed/i.test(text);

  if (hasCancel(message)) {
    return WEBAUTHN_CANCEL_CONTEXT.some((ctx) => message.includes(ctx));
  }

  // A few platform-specific cancellation strings that carry their own context.
  const explicitCancelPhrases = [
    "passkey request cancelled",
    "passkey request canceled",
    "passkey authentication cancelled",
    "passkey authentication canceled",
    "user cancelled",
    "user canceled",
    "cancelled by user",
    "canceled by user",
  ];
  return explicitCancelPhrases.some((phrase) => message.includes(phrase));
}
