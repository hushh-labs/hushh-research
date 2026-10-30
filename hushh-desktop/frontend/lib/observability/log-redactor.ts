const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g;
const VAULT_KEY_PATTERN = /\bvault_[A-Za-z0-9_-]+\b/gi;
const LONG_SECRET_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;

export function redactObservabilityLog(value: string): string {
  return value
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED_TOKEN]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(VAULT_KEY_PATTERN, "[REDACTED_VAULT_KEY]")
    .replace(LONG_SECRET_PATTERN, "[REDACTED_SECRET]");
}

export function redactObservabilityLogValue(value: unknown): unknown {
  return typeof value === "string" ? redactObservabilityLog(value) : value;
}
