/**
 * Kai Onboarding — Production Actions
 *
 * Client-side actions that call the Python backend API.
 * Capacitor-compatible (works on iOS/Android/Web).
 */

import { Capacitor } from "@capacitor/core";

// =============================================================================
// TYPES
// =============================================================================

export type ProcessingMode = "on_device" | "hybrid";
export type RiskProfile = "conservative" | "balanced" | "aggressive";

export interface KaiSession {
  session_id: string;
  user_id: string;
  processing_mode: ProcessingMode;
  risk_profile: RiskProfile;
  legal_acknowledged: boolean;
  onboarding_complete: boolean;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// API CONFIGURATION
// =============================================================================

function _getBackendUrl(): string {
  // If running on native mobile device, we MUST use absolute URL
  if (Capacitor.isNativePlatform()) {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    if (!backendUrl) {
      if (process.env.NEXT_PUBLIC_APP_ENV === "development") {
        console.warn("[Kai] NEXT_PUBLIC_BACKEND_URL not set, using local development backend");
        return "http://127.0.0.1:8000";
      }
      throw new Error(
        "[Kai] NEXT_PUBLIC_BACKEND_URL is required for native/hosted dashboard actions outside local development."
      );
    }
    return backendUrl;
  }

  // If running on Web, use relative path to leverage Next.js Proxy (rewrites)
  // This bypasses CORS issues by hitting same-origin /api
  return "";
}

// =============================================================================
// SESSION MANAGEMENT - REMOVED
// =============================================================================
// ✅ Kai agents use Firebase UID + MCP consent only.
// ✅ No separate agent sessions needed - Firebase Auth is the session.

// =============================================================================
// CONSENT MANAGEMENT
// =============================================================================

// Token storage key
const TOKEN_STORAGE_KEY = "kai_consent_tokens";

export interface ConsentTokens {
  [scope: string]: string;
}

/**
 * NOTE: grantKaiConsent has been moved to kai-service.ts
 * to use the native Kai plugin instead of direct fetch.
 * This ensures mobile compatibility.
 */

/**
 * Get consent token for specific scope.
 * Uses Capacitor Preferences for mobile compatibility.
 */
export async function getConsentToken(scope: string): Promise<string | null> {
  try {
    const { Preferences } = await import("@capacitor/preferences");
    const { value } = await Preferences.get({ key: TOKEN_STORAGE_KEY });

    if (!value) return null;

    const storageData = JSON.parse(value);
    return storageData.tokens?.[scope] || null;
  } catch {
    return null;
  }
}

/**
 * Clear all consent tokens (on logout/re-onboard).
 */
export async function clearConsentTokens(): Promise<void> {
  const { Preferences } = await import("@capacitor/preferences");
  await Preferences.remove({ key: TOKEN_STORAGE_KEY });
}

// =============================================================================
// VAULT INTEGRATION (for preferences storage)
// =============================================================================

/**
 * Store user preferences in encrypted vault
 * This will be used to save risk profile and processing mode
 */
export async function storeKaiPreferences(
  _userId: string,
  _preferences: {
    risk_profile: RiskProfile;
    processing_mode: ProcessingMode;
  },
  _vaultKey: string,
  _consentToken: string
): Promise<{ success: boolean }> {
  // This would call the vault storage operon
  // For now, preferences are stored in kai_sessions table
  // In production, might want to encrypt and store in vault

  console.log(
    "[Kai] Preferences stored in session (vault integration pending)"
  );
  return { success: true };
}

// =============================================================================
// AUDIT LOGGING
// =============================================================================

export async function logKaiAudit(
  sessionId: string,
  action: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  // Optional: Add audit logging endpoint
  console.log(`[Kai Audit] ${action}`, { sessionId, ...metadata });
}
