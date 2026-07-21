const DISABLED_GMAIL_INTEGRATION_VALUES = new Set([
  "0",
  "false",
  "no",
  "off",
  "disabled",
  "paused",
]);

export function resolveGmailIntegrationEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") {
    return true;
  }
  return !DISABLED_GMAIL_INTEGRATION_VALUES.has(raw.trim().toLowerCase());
}

export function isGmailIntegrationEnabled(): boolean {
  return resolveGmailIntegrationEnabled(
    process.env.NEXT_PUBLIC_GMAIL_INTEGRATION_ENABLED,
  );
}
