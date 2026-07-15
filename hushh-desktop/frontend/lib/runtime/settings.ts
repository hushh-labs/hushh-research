function normalizeText(value: string | undefined | null): string {
  return String(value || "").trim();
}

function normalizeUrl(value: string | undefined | null): string {
  return normalizeText(value).replace(/\/+$/, "");
}

function isTruthy(raw: string | undefined | null): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(
    normalizeText(raw).toLowerCase()
  );
}

export const FIREBASE_ADMIN_CREDENTIALS_JSON_ENV =
  "FIREBASE_ADMIN_CREDENTIALS_JSON";

export function resolveServerFirebaseAdminCredentialsJson(): string {
  return normalizeText(process.env[FIREBASE_ADMIN_CREDENTIALS_JSON_ENV]);
}

export function resolveRuntimeBackendUrl(): string {
  return (
    normalizeUrl(process.env.BACKEND_URL) ||
    normalizeUrl(process.env.NEXT_PUBLIC_BACKEND_URL)
  );
}

export function resolveRuntimeFrontendUrl(): string {
  return normalizeUrl(process.env.NEXT_PUBLIC_APP_URL);
}

export function resolveVoiceFailFastPolicy(): boolean {
  return false;
}

export function resolveVoiceDirectBackendPreference(): boolean {
  return isTruthy(process.env.NEXT_PUBLIC_VOICE_DIRECT_BACKEND);
}

export function resolveVoiceForceProxyPreference(): boolean {
  return isTruthy(process.env.NEXT_PUBLIC_VOICE_FORCE_PROXY);
}

export function resolveLegacyLocalTtsCompatEnabled(): boolean {
  return isTruthy(process.env.NEXT_PUBLIC_ENABLE_LEGACY_LOCAL_TTS_COMPAT);
}
