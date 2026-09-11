/**
 * Gmail's branded mark is reserved for consumer Gmail addresses. A Google
 * Workspace address authenticates through the same Google provider, but its
 * profile identity represents a work account instead.
 */
const PERSONAL_GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function isPersonalGmailEmail(
  email: string | null | undefined,
): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;

  const separatorIndex = normalized.lastIndexOf("@");
  if (separatorIndex <= 0) return false;

  return PERSONAL_GMAIL_DOMAINS.has(normalized.slice(separatorIndex + 1));
}

export function shouldUseGoogleBrandMark(
  providerId: string | null | undefined,
  email: string | null | undefined,
): boolean {
  return (
    (providerId === "google" || providerId === "google.com") &&
    isPersonalGmailEmail(email)
  );
}
