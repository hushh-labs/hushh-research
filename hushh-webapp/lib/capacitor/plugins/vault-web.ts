/**
 * HushhVault Web Fallback Implementation
 *
 * This implementation is used when running in a browser (web/cloud mode).
 * It uses the Web Crypto API directly (same as lib/vault/encrypt.ts).
 *
 * NOTE: In native iOS mode, the Swift plugin with SQLCipher is used instead.
 */

import { WebPlugin } from "@capacitor/core";
import type {
  EncryptDataOptions,
  EncryptedPayload,
  DecryptDataOptions,
  DecryptDataResult,
  StorePreferenceOptions,
  GetPreferencesOptions,
  GetPreferencesResult,
  DeriveKeyOptions,
  DeriveKeyResult,
} from "../types";

function bytesToBase64(bytes: Uint8Array): string {
  // Avoid spreading large arrays into fromCharCode, which can overflow the stack.
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class HushhVaultWeb extends WebPlugin {
  /**
   * Derive key using PBKDF2 - matches consent-protocol key derivation
   *
   * Parameters:
   * - iterations: 100,000 (matches config.py)
   * - hash: SHA-256
   * - keyLength: 256 bits (32 bytes, output as 64-char hex)
   */
  async deriveKey(options: DeriveKeyOptions): Promise<DeriveKeyResult> {
    const iterations = options.iterations || 100000;
    const encoder = new TextEncoder();

    // Generate or use provided salt
    let saltBytes: Uint8Array;
    if (options.salt) {
      saltBytes = new Uint8Array(
        options.salt.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
      );
    } else {
      saltBytes = crypto.getRandomValues(new Uint8Array(16));
    }

    // Import passphrase as key material
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(options.passphrase),
      "PBKDF2",
      false,
      ["deriveBits"],
    );

    // Derive the key
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: saltBytes.buffer as ArrayBuffer,
        iterations: iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      256, // 32 bytes
    );

    // Convert to hex string
    const keyHex = Array.from(new Uint8Array(derivedBits))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const saltHex = Array.from(saltBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return {
      keyHex,
      salt: saltHex,
    };
  }

  /**
   * Encrypt data using AES-256-GCM
   *
   * This is equivalent to encryptData() in lib/vault/encrypt.ts
   * Ensures parity between web and native implementations.
   */
  async encryptData(options: EncryptDataOptions): Promise<EncryptedPayload> {
    const keyBytes = new Uint8Array(
      options.keyHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );

    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );

    // 12-byte IV (96 bits) as per NIST recommendation
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();

    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(options.plaintext),
    );

    // Web Crypto returns ciphertext + tag concatenated
    // Tag is last 16 bytes (128 bits)
    const ciphertext = new Uint8Array(encrypted.slice(0, -16));
    const tag = new Uint8Array(encrypted.slice(-16));

    return {
      ciphertext: bytesToBase64(ciphertext),
      iv: bytesToBase64(iv),
      tag: bytesToBase64(tag),
      encoding: "base64",
      algorithm: "aes-256-gcm",
    };
  }

  /**
   * Decrypt data using AES-256-GCM
   *
   * This is equivalent to decryptData() in lib/vault/encrypt.ts
   */
  async decryptData(options: DecryptDataOptions): Promise<DecryptDataResult> {
    const keyBytes = new Uint8Array(
      options.keyHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );

    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );

    const ciphertext = Uint8Array.from(atob(options.payload.ciphertext), (c) =>
      c.charCodeAt(0),
    );
    const tag = Uint8Array.from(atob(options.payload.tag), (c) =>
      c.charCodeAt(0),
    );
    const iv = Uint8Array.from(atob(options.payload.iv), (c) =>
      c.charCodeAt(0),
    );

    // Concatenate ciphertext + tag for Web Crypto
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext);
    combined.set(tag, ciphertext.length);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      combined,
    );

    const decoder = new TextDecoder();
    return {
      plaintext: decoder.decode(decrypted),
    };
  }

  /**
   * Store preference - in web mode, calls the API route
   */
  async storePreference(options: StorePreferenceOptions): Promise<void> {
    const userId = options.userId;
    const domain = options.domain;

    // Call the appropriate vault API based on domain
    const response = await fetch(`/api/vault/${domain}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        fieldName: options.fieldName,
        ciphertext: options.data.ciphertext,
        iv: options.data.iv,
        tag: options.data.tag,
        consentTokenId: options.consentTokenId,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to store preference: ${error}`);
    }
  }

  /**
   * Get preferences - in web mode, calls the API route
   */
  async getPreferences(
    options: GetPreferencesOptions,
  ): Promise<GetPreferencesResult> {
    const response = await fetch(
      `/api/vault/${options.domain}?userId=${options.userId}`,
    );

    if (!response.ok) {
      if (response.status === 404) {
        return { preferences: [] };
      }
      throw new Error("Failed to get preferences");
    }

    const data = await response.json();

    // Transform API response to VaultRecord format
    const preferences = (data.preferences || []).map(
      (pref: {
        field_name: string;
        ciphertext: string;
        iv: string;
        tag: string;
        created_at: number;
        updated_at?: number;
        consent_token_id?: string;
      }) => ({
        userId: options.userId,
        domain: options.domain,
        fieldName: pref.field_name,
        data: {
          ciphertext: pref.ciphertext,
          iv: pref.iv,
          tag: pref.tag,
          encoding: "base64" as const,
          algorithm: "aes-256-gcm" as const,
        },
        createdAt: pref.created_at,
        updatedAt: pref.updated_at,
        consentTokenId: pref.consent_token_id,
      }),
    );

    return { preferences };
  }

  /**
   * Delete preferences - in web mode, not implemented
   * (cloud mode typically doesn't delete, just revokes consent)
   */
  async deletePreferences(_options: {
    userId: string;
    domain: string;
  }): Promise<void> {
    console.warn("deletePreferences not implemented in web mode");
  }

  // ==================== Cloud DB Methods (Web Fallback) ====================
  // These call the API routes on web

  /**
   * Check if user has a vault - web fallback calls API route
   */
  async hasVault(options: {
    userId: string;
    authToken?: string;
  }): Promise<{ exists: boolean }> {
    try {
      const headers: HeadersInit = {};
      if (options.authToken) {
        headers.Authorization = `Bearer ${options.authToken}`;
      }
      const response = await fetch(
        `/api/vault/check?userId=${options.userId}`,
        {
          headers,
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) return { exists: false };
      const data = await response.json();
      return { exists: data.hasVault || false };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Get encrypted vault key - web fallback calls API route
   */
  async getVault(options: { userId: string; authToken?: string }): Promise<{
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
  }> {
    const response = await fetch(`/api/vault/get?userId=${options.userId}`);
    if (!response.ok) throw new Error("Vault not found");
    return await response.json();
  }

  /**
   * Store encrypted vault key - web fallback calls API route
   */
  async setupVault(options: {
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
  }): Promise<{ success: boolean }> {
    const response = await fetch("/api/vault/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    if (!response.ok) throw new Error("Failed to setup vault");
    return { success: true };
  }

  async upsertVaultWrapper(options: {
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
  }): Promise<{ success: boolean }> {
    const response = await fetch("/api/vault/wrapper/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    if (!response.ok) throw new Error("Failed to upsert wrapper");
    return { success: true };
  }

  async deleteVaultWrapper(options: {
    userId: string;
    vaultKeyHash: string;
    method: string;
    wrapperId?: string;
    fallbackPrimaryMethod?: string;
    fallbackPrimaryWrapperId?: string;
    authToken?: string;
    vaultOwnerToken?: string;
  }): Promise<{ success: boolean }> {
    const headers: HeadersInit = { "Content-Type": "application/json" };
    if (options.authToken) {
      headers.Authorization = `Bearer ${options.authToken}`;
    }
    if (options.vaultOwnerToken) {
      headers["X-Hushh-Consent"] = `Bearer ${options.vaultOwnerToken}`;
    }
    const response = await fetch("/api/vault/wrapper/delete", {
      method: "POST",
      headers,
      body: JSON.stringify(options),
    });
    if (!response.ok) throw new Error("Failed to remove wrapper");
    return { success: true };
  }

  async setPrimaryVaultMethod(options: {
    userId: string;
    primaryMethod: string;
    primaryWrapperId?: string;
    authToken?: string;
  }): Promise<{ success: boolean }> {
    const response = await fetch("/api/vault/primary/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    if (!response.ok) throw new Error("Failed to set primary method");
    return { success: true };
  }

  async isPasskeyAvailable(_options?: {
    rpId?: string;
  }): Promise<{ available: boolean; reason?: string }> {
    return {
      available: false,
      reason: "Native passkey plugin path unavailable in web fallback",
    };
  }

  async registerPasskeyPrf(_options: {
    userId: string;
    displayName: string;
    rpId: string;
  }): Promise<{
    credentialId: string;
    prfSalt: string;
    vaultKeyHex: string;
  }> {
    throw new Error("registerPasskeyPrf is not available in web fallback");
  }

  async authenticatePasskeyPrf(_options: {
    userId: string;
    rpId: string;
    credentialId?: string;
    prfSalt: string;
  }): Promise<{
    credentialId: string;
    vaultKeyHex: string;
  }> {
    throw new Error("authenticatePasskeyPrf is not available in web fallback");
  }

  // ==================== Domain Data Methods (Web Fallback) ====================

  // ==================== Consent Methods (Web Fallback) ====================

  async storePreferencesToCloud(options: {
    userId: string;
    domain: string;
    fieldName: string;
    ciphertext: string;
    iv: string;
    tag: string;
    consentTokenId: string;
    authToken?: string;
  }): Promise<{ success: boolean }> {
    console.log("Web Stub: storePreferencesToCloud", options);
    // On web, this should fallback to API calls, but this is a native-only path in ApiService.
    return { success: true };
  }

  async getPendingConsents(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{ pending: any[] }> {
    const headers: Record<string, string> = {};
    if (options.vaultOwnerToken) {
      headers["Authorization"] = `Bearer ${options.vaultOwnerToken}`;
    }
    const response = await fetch(
      `/api/consent/pending?userId=${options.userId}`,
      { headers },
    );
    if (!response.ok) throw new Error("Failed to fetch pending");
    const data = await response.json();
    return { pending: data.pending || [] };
  }

  async getActiveConsents(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{ active: any[] }> {
    const headers: Record<string, string> = {};
    if (options.vaultOwnerToken) {
      headers["Authorization"] = `Bearer ${options.vaultOwnerToken}`;
    }
    const response = await fetch(
      `/api/consent/active?userId=${options.userId}`,
      { headers },
    );
    if (!response.ok) throw new Error("Failed to fetch active");
    const data = await response.json();
    return { active: data.active || [] };
  }

  async getConsentHistory(options: {
    userId: string;
    vaultOwnerToken?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: any[] }> {
    const headers: Record<string, string> = {};
    if (options.vaultOwnerToken) {
      headers["Authorization"] = `Bearer ${options.vaultOwnerToken}`;
    }
    const page = options.page || 1;
    const limit = options.limit || 50;
    const response = await fetch(
      `/api/consent/history?userId=${options.userId}&page=${page}&limit=${limit}`,
      { headers },
    );
    if (!response.ok) throw new Error("Failed to fetch history");
    const data = await response.json();
    return { items: data.items || [] };
  }

  async getVaultStatus(options: {
    userId: string;
    vaultOwnerToken: string;
    authToken: string;
  }): Promise<Record<string, unknown>> {
    // Web implementation uses the Next.js proxy route.
    const response = await fetch("/api/vault/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.authToken}`,
      },
      body: JSON.stringify({
        userId: options.userId,
        consentToken: options.vaultOwnerToken,
      }),
    });
    if (!response.ok) throw new Error("Failed to fetch vault status");
    return response.json();
  }
}
