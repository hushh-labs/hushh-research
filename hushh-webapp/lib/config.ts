// lib/config.ts

import { resolveAppEnvironment } from "./app-env";
import { resolveRuntimeBackendUrl, resolveRuntimeFrontendUrl } from "./runtime/settings";

/**
 * Environment Configuration
 *
 * Runtime behavior is keyed off canonical frontend environment identity:
 * NEXT_PUBLIC_APP_ENV=development|uat|production.
 *
 * Legacy compatibility fallback is preserved inside resolveAppEnvironment()
 * for NEXT_PUBLIC_OBSERVABILITY_ENV and NEXT_PUBLIC_ENVIRONMENT_MODE.
 */

const getEnvironmentMode = () => resolveAppEnvironment();

function normalizeUrl(value: string | undefined | null): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

function resolveBrowserDefaultBackendUrl(): string {
  return getEnvironmentMode() === "development" ? "http://127.0.0.1:8000" : "";
}

export const ENVIRONMENT_MODE = getEnvironmentMode();

export const isDevelopment = () => getEnvironmentMode() === "development";
export const isProduction = () => getEnvironmentMode() === "production";

/**
 * May this process honour a development AUTH bypass?
 *
 * `isDevelopment()` answers "is this build labelled development", which is the right
 * question for a URL default and the wrong one for `DEV_AUTO_GRANT`, `Bearer
 * DEV_TOKEN`, and the vault routes that skip a failed validation. Those are auth
 * bypasses, and the label alone would hand them to any hosted deployment that
 * happens to be named development.
 *
 * That is not hypothetical. The dev backend now reports `ENVIRONMENT=dev`; the moment
 * the frontend follows with `NEXT_PUBLIC_APP_ENV=dev`, `resolveAppEnvironment()`
 * normalises it to `development` and all twelve bypasses would turn on for an
 * internet-reachable service holding real test accounts.
 *
 * So this requires the label AND the absence of a deploy lane. `HUSHH_DEPLOY_ENV` is
 * set on every hosted Cloud Run service (verified present on `hushh-webapp` in
 * `hushh-pda-dev`) and absent on a developer's machine, which is what "local"
 * actually means. It is read without a `NEXT_PUBLIC_` prefix on purpose: every caller
 * is a server-side route handler, and a value the browser could see would be a value
 * an attacker could reason about.
 *
 * Behaviour today is unchanged — the frontend still reports `uat`, so `isDevelopment()`
 * is already false on every hosted lane. This closes the door before it is opened.
 */
export const devAuthBypassAllowed = () => {
  if (!isDevelopment()) return false;
  return String(process.env.HUSHH_DEPLOY_ENV ?? "").trim() === "";
};

// Backend URL for Python consent-protocol server
export const BACKEND_URL =
  normalizeUrl(resolveRuntimeBackendUrl()) ||
  resolveBrowserDefaultBackendUrl();

// Frontend origin
export const APP_FRONTEND_ORIGIN =
  normalizeUrl(resolveRuntimeFrontendUrl()) ||
  (getEnvironmentMode() === "development" ? "http://localhost:3000" : "");

// ============================================================================
// SECURITY EVENT TYPES
// ============================================================================

/**
 * Security event types for audit logging.
 */
export type SecurityEventType =
  // Token validation events
  | "TOKEN_VALID"
  | "TOKEN_INVALID"
  | "TOKEN_VALIDATION_FAILED"
  | "TOKEN_VALIDATION_ERROR"
  | "SCOPE_MISMATCH"
  // Firebase auth events
  | "FIREBASE_TOKEN_VALID"
  | "FIREBASE_TOKEN_INVALID"
  | "FIREBASE_VALIDATION_ERROR"
  // Vault events
  | "VAULT_READ_REJECTED"
  | "VAULT_READ_SUCCESS"
  | "VAULT_WRITE_REJECTED"
  | "VAULT_WRITE_SUCCESS"
  | "VAULT_KEY_REJECTED"
  | "VAULT_KEY_SUCCESS"
  | "VAULT_CHECK_REJECTED"
  | "VAULT_CHECK_SUCCESS"
  | "VAULT_SETUP_SUCCESS"
  | "PREFERENCES_READ_REJECTED"
  | "PREFERENCES_READ_SUCCESS"
  // Consent events
  | "CONSENT_VERIFIED"
  | "CONSENT_REQUIRED"
  | "CONSENT_INVALID"
  // User events
  | "USER_MISMATCH"
  // Chat/Agent events
  | "CHAT_REJECTED"
  | "RECOMMEND_REJECTED"
  | "RECOMMEND_SUCCESS"
  // Development mode
  | "DEV_AUTO_GRANT"
  | "DEV_FIREBASE_BYPASS";

/**
 * Security event details payload.
 */
export interface SecurityEventDetails {
  userId?: string;
  agentId?: string;
  scope?: string;
  reason?: string;
  error?: string;
  domain?: string;
  field?: string;
  status?: number;
  expected?: string;
  actual?: string;
  exists?: boolean;
  count?: number;
  [key: string]: unknown;
}

/**
 * Log a security event with structured data.
 */
export function logSecurityEvent(
  event: SecurityEventType,
  details: SecurityEventDetails
) {
  const timestamp = new Date().toISOString();
  const mode = getEnvironmentMode();
  console.log(
    `[SECURITY ${mode.toUpperCase()}] ${timestamp} - ${event}`,
    details
  );
}
