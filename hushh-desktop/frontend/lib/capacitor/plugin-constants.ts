/**
 * Shared parameter names for native plugins.
 *
 * Use these constants in TypeScript to ensure consistency with native implementations.
 * Native implementations (Swift/Kotlin) MUST use these exact strings.
 *
 * When adding new parameters:
 * 1. Add constant here
 * 2. Update docs/plugin_api_reference.md
 * 3. Use constant in TypeScript calls
 * 4. Use exact string in Swift and Kotlin
 */

export const PluginParams = {
  // Common parameters
  Common: {
    AUTH_TOKEN: "authToken",
    USER_ID: "userId",
  },

  // HushhVault encryption parameters
  Vault: {
    KEY_HEX: "keyHex",
    PLAINTEXT: "plaintext",
    PAYLOAD: "payload",
    CIPHERTEXT: "ciphertext",
    IV: "iv",
    TAG: "tag",
    SALT: "salt",
    PASSPHRASE: "passphrase",
    ITERATIONS: "iterations",
    DOMAIN: "domain",
    FIELD_NAME: "fieldName",
  },

  // Kai parameters
  Kai: {
    TICKER: "ticker",
    CONSENT_TOKEN: "consentToken",
    RISK_PROFILE: "riskProfile",
    PROCESSING_MODE: "processingMode",
    INVESTOR_CONTEXT: "investorContext",
    CONTEXT: "context",
    SCOPES: "scopes",
    PREFERENCES: "preferences",
  },

  // HushhConsent parameters
  Consent: {
    AGENT_ID: "agentId",
    SCOPE: "scope",
    TOKEN: "token",
    EXPECTED_SCOPE: "expectedScope",
    EXPIRES_IN: "expiresIn",
    REQUEST_ID: "requestId",
  },

  // HushhKeychain parameters
  Keychain: {
    KEY: "key",
    VALUE: "value",
    PROMPT_MESSAGE: "promptMessage",
  },

  // HushhSync parameters
  Sync: {
    // Uses Common.AUTH_TOKEN
  },

  // HushhSettings - uses property names directly
  Settings: {
    USE_REMOTE_SYNC: "useRemoteSync",
    SYNC_ON_WIFI_ONLY: "syncOnWifiOnly",
    USE_REMOTE_LLM: "useRemoteLLM",
    PREFERRED_LLM_PROVIDER: "preferredLLMProvider",
    REQUIRE_BIOMETRIC_UNLOCK: "requireBiometricUnlock",
    AUTO_LOCK_TIMEOUT: "autoLockTimeout",
    THEME: "theme",
    HAPTIC_FEEDBACK: "hapticFeedback",
    SHOW_DEBUG_INFO: "showDebugInfo",
    VERBOSE_LOGGING: "verboseLogging",
  },
} as const;

/**
 * Plugin jsNames - must match exactly in:
 * - TypeScript registerPlugin() calls
 * - Swift CAPBridgedPlugin jsName
 * - Kotlin @CapacitorPlugin(name = "...")
 */
export const PluginNames = {
  AUTH: "HushhAuth",
  VAULT: "HushhVault",
  CONSENT: "HushhConsent",
  KAI: "Kai",
  SYNC: "HushhSync",
  SETTINGS: "HushhSettings",
  KEYCHAIN: "HushhKeychain", // Note: iOS uses HushhKeystorePlugin class but jsName is HushhKeychain
  CONTACTS: "HushhContacts",
} as const;

/**
 * Type helper for extracting parameter values
 */
export type PluginParamValue<
  T extends keyof typeof PluginParams,
  K extends keyof (typeof PluginParams)[T]
> = (typeof PluginParams)[T][K];
