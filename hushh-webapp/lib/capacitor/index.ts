/**
 * Hushh Consent Protocol - Capacitor Native Plugins
 *
 * This file registers the native Swift plugins that implement the consent protocol.
 * The plugins provide:
 *
 * - HushhConsentPlugin: Token issuance, validation, revocation (mirrors token.py)
 * - HushhVaultPlugin: Encrypted storage with SQLCipher (mirrors encrypt.ts + vault)
 * - HushhKeychainPlugin: iOS Keychain for secure key storage
 *
 * IMPORTANT: These plugins call into native Swift code.
 * For web/cloud deployment, use the existing API routes instead.
 */

import { registerPlugin } from "@capacitor/core";

import type {
  // Consent types
  IssueTokenOptions,
  IssueTokenResult,
  ValidateTokenOptions,
  ValidateTokenResult,
  RevokeTokenOptions,
  CreateTrustLinkOptions,
  TrustLink,
  VerifyTrustLinkOptions,
  VerifyTrustLinkResult,
  // Vault types
  EncryptDataOptions,
  EncryptedPayload,
  DecryptDataOptions,
  DecryptDataResult,
  StorePreferenceOptions,
  GetPreferencesOptions,
  GetPreferencesResult,
  DeriveKeyOptions,
  DeriveKeyResult,
  // Keychain types
  KeychainSetOptions,
  KeychainGetOptions,
  KeychainGetResult,
  KeychainDeleteOptions,
} from "./types";

// ==================== HushhAuthPlugin ====================
// Native iOS/Android Authentication (Google Sign-In + Sign in with Apple)

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  photoUrl: string;
  emailVerified?: boolean;
}

export interface HushhAuthPlugin {
  /**
   * Sign in with Google using native iOS/Android UI
   * Returns ID token + access token for Firebase credential exchange
   */
  signIn(): Promise<{
    idToken: string;
    accessToken: string;
    user: AuthUser;
  }>;

  /**
   * Sign in with Apple using native iOS AuthenticationServices or Firebase OAuthProvider
   * 
   * iOS: Uses ASAuthorizationController (native Apple Sign-In sheet)
   * Android/Web: Uses Firebase OAuthProvider (web-based OAuth flow)
   * 
   * Returns ID token for Firebase credential exchange
   * Note: Apple may return hidden email (relay address) if user chose to hide it
   */
  signInWithApple(): Promise<{
    idToken: string;
    accessToken?: string;
    rawNonce?: string;  // iOS only - needed for JS SDK sync if required
    user: AuthUser;
  }>;

  /**
   * Sign out from all providers (clears tokens from Keychain/Keystore)
   */
  signOut(): Promise<void>;

  /**
   * Get cached ID token (from memory or Keychain/Keystore)
   */
  getIdToken(): Promise<{ idToken: string | null }>;

  /**
   * Get currently signed-in user
   */
  getCurrentUser(): Promise<{ user: AuthUser | null }>;

  /**
   * Check if user is signed in
   */
  isSignedIn(): Promise<{ signedIn: boolean }>;
}

export const HushhAuth = registerPlugin<HushhAuthPlugin>("HushhAuth", {
  web: () => import("./plugins/auth-web").then((m) => new m.HushhAuthWeb()),
});

// ==================== HushhConsentPlugin ====================
// Mirrors: consent-protocol/hushh_mcp/consent/token.py
//          consent-protocol/hushh_mcp/trust/link.py

export interface HushhConsentPlugin {
  /**
   * Issue a new consent token
   * Mirrors: issue_token() in token.py
   *
   * Token format: HCT:base64(userId|agentId|scope|issuedAt|expiresAt).signature
   */
  issueToken(options: IssueTokenOptions): Promise<IssueTokenResult>;

  /**
   * Validate a consent token
   * Mirrors: validate_token() in token.py
   *
   * Checks: prefix, signature (HMAC-SHA256), expiry, scope match
   */
  validateToken(options: ValidateTokenOptions): Promise<ValidateTokenResult>;

  /**
   * Revoke a consent token
   * Mirrors: revoke_token() in token.py
   */
  revokeToken(options: RevokeTokenOptions): Promise<void>;

  /**
   * Check if a token is revoked
   * Mirrors: is_token_revoked() in token.py
   */
  isTokenRevoked(options: { token: string }): Promise<{ revoked: boolean }>;

  /**
   * Create a TrustLink for agent-to-agent delegation
   * Mirrors: create_trust_link() in link.py
   */
  createTrustLink(options: CreateTrustLinkOptions): Promise<TrustLink>;

  /**
   * Verify a TrustLink
   * Mirrors: verify_trust_link() in link.py
   */
  verifyTrustLink(
    options: VerifyTrustLinkOptions
  ): Promise<VerifyTrustLinkResult>;

  // ==================== Backend API Methods ====================

  /**
   * Issue VAULT_OWNER consent token for authenticated user.
   *
   * Called after vault unlock. Verifies Firebase ID token and issues
   * the master VAULT_OWNER scope token for accessing own vault data.
   *
   * Platform routing:
   * - iOS/Android: Native HTTP call to /api/consent/vault-owner-token
   * - Web: Proxies through Next.js API route (not typically called directly)
   */
  issueVaultOwnerToken(options: {
    userId: string;
    authToken?: string; // Firebase ID token (legacy name)
    idToken?: string; // Firebase ID token (preferred)
  }): Promise<{
    token: string;
    expiresAt: number;
    scope: string;
  }>;

  getPending(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{ consents: any[] }>;

  getActive(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{ consents: any[] }>;

  getHistory(options: {
    userId: string;
    vaultOwnerToken?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: any[] }>;

  approve(options: {
    requestId: string;
    userId?: string;
    encryptedData?: string;
    encryptedIv?: string;
    encryptedTag?: string;
    exportKey?: string;
    wrappedExportKey?: string;
    wrappedKeyIv?: string;
    wrappedKeyTag?: string;
    senderPublicKey?: string;
    wrappingAlg?: string;
    connectorKeyId?: string;
    vaultOwnerToken?: string;
  }): Promise<{ success: boolean }>;

  deny(options: {
    requestId: string;
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{ success: boolean }>;

  cancel(options: {
    requestId: string;
    vaultOwnerToken?: string;
  }): Promise<{ success: boolean }>;

  revokeConsent(options: {
    userId: string;
    scope: string;
    vaultOwnerToken?: string;
  }): Promise<{ success: boolean; lockVault?: boolean }>;
}

export const HushhConsent = registerPlugin<HushhConsentPlugin>("HushhConsent", {
  // Web fallback - in web/cloud mode, these would call the API routes
  web: () =>
    import("./plugins/consent-web").then((m) => new m.HushhConsentWeb()),
});

// ==================== HushhVaultPlugin ====================
// Mirrors: lib/vault/encrypt.ts (client-side encryption)
//          consent-protocol vault storage concepts

export interface HushhVaultPlugin {
  /**
   * Derive an encryption key from passphrase
   * Mirrors: PBKDF2 key derivation in encrypt.ts
   *
   * Uses: PBKDF2 with 100,000 iterations, SHA-256, 256-bit output
   */
  deriveKey(options: DeriveKeyOptions): Promise<DeriveKeyResult>;

  /**
   * Encrypt data using AES-256-GCM
   * Mirrors: encryptData() in encrypt.ts
   *
   * Uses: 12-byte IV, returns ciphertext + IV + tag in base64
   */
  encryptData(options: EncryptDataOptions): Promise<EncryptedPayload>;

  /**
   * Decrypt data using AES-256-GCM
   * Mirrors: decryptData() in encrypt.ts
   */
  decryptData(options: DecryptDataOptions): Promise<DecryptDataResult>;

  /**
   * Legacy local preference write surface.
   * Route-facing features should use cloud-backed preference flows instead.
   * @deprecated Compatibility-only local path.
   */
  storePreference(options: StorePreferenceOptions): Promise<void>;

  /**
   * Legacy local preference read surface kept for compatibility.
   * @deprecated Compatibility-only local path.
   */
  getPreferences(options: GetPreferencesOptions): Promise<GetPreferencesResult>;

  /**
   * Legacy local preference delete surface kept for compatibility.
   * @deprecated Compatibility-only local path.
   */
  deletePreferences(options: { userId: string; domain: string }): Promise<void>;

  // ==================== Cloud DB Methods ====================
  // These call the Cloud Run backend directly from iOS

  /**
   * Check if user has a vault on Cloud DB
   * Replaces: /api/vault/check endpoint on iOS
   */
  hasVault(options: {
    userId: string;
    authToken?: string;
  }): Promise<{ exists: boolean }>;

  /**
   * Get encrypted vault key from Cloud DB
   * Replaces: /api/vault/get endpoint on iOS
   */
  getVault(options: { userId: string; authToken?: string }): Promise<{
    vaultKeyHash: string;
    primaryMethod: string;
    primaryWrapperId?: string;
    recoveryEncryptedVaultKey: string;
    recoverySalt: string;
    recoveryIv: string;
    wrappers: Array<{
      method: string;
      wrapperId?: string;
      encryptedVaultKey: string;
      salt: string;
      iv: string;
      passkeyCredentialId?: string;
      passkeyPrfSalt?: string;
      passkeyRpId?: string;
      passkeyProvider?: string;
      passkeyDeviceLabel?: string;
      passkeyLastUsedAt?: number;
    }>;
  }>;

  /**
   * Store encrypted vault key to Cloud DB
   * Replaces: /api/vault/setup endpoint on iOS
   */
  setupVault(options: {
    userId: string;
    vaultKeyHash: string;
    primaryMethod: string;
    primaryWrapperId?: string;
    recoveryEncryptedVaultKey: string;
    recoverySalt: string;
    recoveryIv: string;
    wrappers: Array<{
      method: string;
      wrapperId?: string;
      encryptedVaultKey: string;
      salt: string;
      iv: string;
      passkeyCredentialId?: string;
      passkeyPrfSalt?: string;
      passkeyRpId?: string;
      passkeyProvider?: string;
      passkeyDeviceLabel?: string;
      passkeyLastUsedAt?: number;
    }>;
    authToken?: string;
  }): Promise<{ success: boolean }>;

  upsertVaultWrapper(options: {
    userId: string;
    vaultKeyHash: string;
    method: string;
    wrapperId?: string;
    encryptedVaultKey: string;
    salt: string;
    iv: string;
    passkeyCredentialId?: string;
    passkeyPrfSalt?: string;
    passkeyRpId?: string;
    passkeyProvider?: string;
    passkeyDeviceLabel?: string;
    passkeyLastUsedAt?: number;
    authToken?: string;
  }): Promise<{ success: boolean }>;

  setPrimaryVaultMethod(options: {
    userId: string;
    primaryMethod: string;
    primaryWrapperId?: string;
    authToken?: string;
  }): Promise<{ success: boolean }>;

  isPasskeyAvailable(options?: { rpId?: string }): Promise<{
    available: boolean;
    reason?: string;
  }>;

  registerPasskeyPrf(options: {
    userId: string;
    displayName: string;
    rpId: string;
  }): Promise<{
    credentialId: string;
    prfSalt: string;
    vaultKeyHex: string;
  }>;

  authenticatePasskeyPrf(options: {
    userId: string;
    rpId: string;
    credentialId?: string;
    prfSalt: string;
  }): Promise<{
    credentialId: string;
    vaultKeyHex: string;
  }>;

  // Consents (New)
  /**
   * Canonical cross-platform encrypted preference write path.
   * Native method mapping to /db/$domain/store
   */
  storePreferencesToCloud(options: {
    userId: string;
    domain: string;
    fieldName: string;
    ciphertext: string;
    iv: string;
    tag: string;
    consentToken: string;
    authToken?: string;
  }): Promise<{ success: boolean }>;

  getPendingConsents(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{ pending: any[] }>;

  getActiveConsents(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{ active: any[] }>;

  getConsentHistory(options: {
    userId: string;
    vaultOwnerToken?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: any[] }>;

  /**
   * Vault status (domain counts without decrypted data).
   * Calls backend: POST /db/vault/status
   * Requires:
   * - Firebase ID token as `authToken` (Authorization header)
   * - VAULT_OWNER token as `vaultOwnerToken` (JSON body `consentToken`)
   */
  getVaultStatus(options: {
    userId: string;
    vaultOwnerToken: string;
    authToken: string;
  }): Promise<Record<string, unknown>>;
}

export const HushhVault = registerPlugin<HushhVaultPlugin>("HushhVault", {
  web: () => import("./plugins/vault-web").then((m) => new m.HushhVaultWeb()),
});

// ==================== HushhKeychainPlugin ====================
// iOS Keychain for secure storage of vault key and secrets

export interface HushhKeychainPlugin {
  /**
   * Store a value in iOS Keychain
   */
  set(options: KeychainSetOptions): Promise<void>;

  /**
   * Retrieve a value from iOS Keychain
   */
  get(options: KeychainGetOptions): Promise<KeychainGetResult>;

  /**
   * Delete a value from iOS Keychain
   */
  delete(options: KeychainDeleteOptions): Promise<void>;

  /**
   * Check if biometric authentication is available
   */
  isBiometricAvailable(): Promise<{
    available: boolean;
    type: "faceId" | "touchId" | "none";
  }>;

  /**
   * Store a value requiring biometric authentication to retrieve
   */
  setBiometric(
    options: KeychainSetOptions & { promptMessage: string }
  ): Promise<void>;

  /**
   * Retrieve a biometric-protected value
   */
  getBiometric(
    options: KeychainGetOptions & { promptMessage: string }
  ): Promise<KeychainGetResult>;
}

export const HushhKeychain = registerPlugin<HushhKeychainPlugin>(
  "HushhKeychain",
  {
    web: () =>
      import("./plugins/keychain-web").then((m) => new m.HushhKeychainWeb()),
  }
);

// ==================== HushhSettingsPlugin ====================
// Settings management - DEV defaults to remote

export interface HushhSettingsData {
  useRemoteSync: boolean;
  syncOnWifiOnly: boolean;
  useRemoteLLM: boolean;
  preferredLLMProvider: "local" | "mlx" | "openai" | "anthropic" | "google";
  requireBiometricUnlock: boolean;
  autoLockTimeout: number;
  theme: "system" | "light" | "dark";
  hapticFeedback: boolean;
  showDebugInfo: boolean;
  verboseLogging: boolean;
}

export interface HushhSettingsPlugin {
  getSettings(): Promise<HushhSettingsData>;
  updateSettings(
    options: Partial<HushhSettingsData>
  ): Promise<{ success: boolean }>;
  resetSettings(): Promise<{ success: boolean }>;
  shouldUseLocalAgents(): Promise<{ value: boolean }>;
  shouldSyncToCloud(): Promise<{ value: boolean }>;
}

export const HushhSettingsNative = registerPlugin<HushhSettingsPlugin>(
  "HushhSettings",
  {
    web: () =>
      import("./plugins/settings-web").then((m) => new m.HushhSettingsWeb()),
  }
);

// ==================== HushhDatabasePlugin ====================
// Local SQLite/IndexedDB storage

export interface HushhDatabasePlugin {
  initialize(): Promise<{ success: boolean }>;
  hasVault(options: { userId: string }): Promise<{ exists: boolean }>;
  storeVaultKey(options: {
    userId: string;
    authMethod: string;
    encryptedVaultKey: string;
    salt: string;
    iv: string;
    recoveryEncryptedVaultKey: string;
    recoverySalt: string;
    recoveryIv: string;
  }): Promise<{ success: boolean }>;
  getVaultKey(options: { userId: string }): Promise<{
    encryptedVaultKey: string;
    salt: string;
    iv: string;
    recoveryEncryptedVaultKey: string;
    recoverySalt: string;
    recoveryIv: string;
  }>;
  close(): Promise<{ success: boolean }>;
}

export const HushhDatabase = registerPlugin<HushhDatabasePlugin>(
  "HushhDatabase",
  {
    web: () =>
      import("./plugins/database-web").then((m) => new m.HushhDatabaseWeb()),
  }
);

// ==================== HushhAgentPlugin ====================
// Local agent runtime

export interface AgentResponse {
  response: string;
  sessionState?: Record<string, unknown>;
  collectedData?: Record<string, unknown>;
  isComplete: boolean;
  needsConsent: boolean;
  consentScope?: string;
  uiType?: "buttons" | "checkbox" | "text";
  options?: string[];
  allowCustom?: boolean;
  allowNone?: boolean;
  consentToken?: string;
  consentIssuedAt?: number;
  consentExpiresAt?: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  port: number;
  available: boolean;
}

export interface HushhAgentPlugin {
  handleMessage(options: {
    message: string;
    userId: string;
    agentId?: string;
    sessionState?: Record<string, unknown>;
  }): Promise<AgentResponse>;
  classifyIntent(options: { message: string }): Promise<{
    hasDelegate: boolean;
    targetAgent: string;
    targetPort?: number;
    domain: string;
  }>;
  getAgentInfo(): Promise<{
    agents: AgentInfo[];
    version: string;
    protocolVersion: string;
  }>;
}

export const HushhAgent = registerPlugin<HushhAgentPlugin>("HushhAgent", {
  web: () => import("./plugins/agent-web").then((m) => new m.HushhAgentWeb()),
});

// ==================== HushhSyncPlugin ====================
// Handles local-cloud data synchronization

export interface SyncResult {
  success: boolean;
  pushedRecords: number;
  pulledRecords: number;
  conflicts: number;
  timestamp: number;
}

export interface SyncStatus {
  pendingCount: number;
  lastSyncTimestamp: number;
  hasPendingChanges: boolean;
}

export interface HushhSyncPlugin {
  /**
   * Full sync: push local changes then pull remote changes
   */
  sync(options?: { authToken?: string }): Promise<SyncResult>;

  /**
   * Push local changes to cloud
   */
  push(options?: {
    authToken?: string;
  }): Promise<{ success: boolean; pushedRecords: number }>;

  /**
   * Pull remote changes to local
   */
  pull(options?: {
    authToken?: string;
  }): Promise<{ success: boolean; pulledRecords: number }>;

  /**
   * Sync a specific user's vault
   */
  syncVault(options: {
    userId: string;
    authToken?: string;
  }): Promise<{ success: boolean }>;

  /**
   * Get current sync status
   */
  getSyncStatus(): Promise<SyncStatus>;
}

export const HushhSync = registerPlugin<HushhSyncPlugin>("HushhSync", {
  web: () => import("./plugins/sync-web").then((m) => new m.HushhSyncWeb()),
});

// ==================== HushhNotificationsPlugin ====================
// Push notification token registration (FCM/APNs)

export interface HushhNotificationsPlugin {
  /**
   * Register push notification token for consent notifications.
   * Next.js source of truth: POST /api/notifications/register
   * Backend: POST /api/notifications/register
   */
  registerPushToken(options: {
    userId: string;
    token: string;
    platform: "web" | "ios" | "android";
    idToken: string; // Firebase ID token
    backendUrl?: string;
  }): Promise<{ success: boolean }>;

  /**
   * Unregister push notification token(s).
   * Next.js source of truth: DELETE /api/notifications/unregister
   * Backend: DELETE /api/notifications/unregister
   */
  unregisterPushToken(options: {
    userId: string;
    idToken: string; // Firebase ID token
    platform?: "web" | "ios" | "android";
    backendUrl?: string;
  }): Promise<{ success: boolean }>;
}

export const HushhNotifications = registerPlugin<HushhNotificationsPlugin>(
  "HushhNotifications",
  {
    web: () =>
      import("./plugins/notifications-web").then(
        (m) => new m.HushhNotificationsWeb()
      ),
  }
);

// ==================== HushhPersonalKnowledgeModelPlugin ====================
// PKM operations for dynamic domain/attribute management

export { HushhPersonalKnowledgeModel } from "./personal-knowledge-model";
export type { HushhPersonalKnowledgeModelPlugin } from "./personal-knowledge-model";

// ==================== Export all ====================

export * from "./types";
export * from "./account";
