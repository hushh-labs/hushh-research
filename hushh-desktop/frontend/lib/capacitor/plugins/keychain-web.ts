/**
 * HushhKeychain Web Fallback Implementation
 *
 * This implementation is used when running in a browser (web/cloud mode).
 * Uses an in-memory Map as a fallback (NOT secure like iOS Keychain).
 *
 * WARNING: This is for development/testing only.
 * In production web mode, consider using IndexedDB with encryption.
 *
 * NOTE: In native iOS mode, the Swift plugin with real Keychain is used.
 */

import { WebPlugin } from "@capacitor/core";
import type {
  KeychainSetOptions,
  KeychainGetOptions,
  KeychainGetResult,
  KeychainDeleteOptions,
} from "../types";

const KEYCHAIN_PREFIX = "hushh_keychain_";

export class HushhKeychainWeb extends WebPlugin {
  /** In-memory store replacing sessionStorage for web fallback */
  private store = new Map<string, string>();

  /**
   * Store a value - uses in-memory Map in web mode
   */
  async set(options: KeychainSetOptions): Promise<void> {
    const key = KEYCHAIN_PREFIX + options.key;
    this.store.set(key, options.value);
  }

  /**
   * Retrieve a value
   */
  async get(options: KeychainGetOptions): Promise<KeychainGetResult> {
    const key = KEYCHAIN_PREFIX + options.key;
    return { value: this.store.get(key) ?? null };
  }

  /**
   * Delete a value
   */
  async delete(options: KeychainDeleteOptions): Promise<void> {
    const key = KEYCHAIN_PREFIX + options.key;
    this.store.delete(key);
  }

  /**
   * Check biometric availability - not available in web mode
   */
  async isBiometricAvailable(): Promise<{
    available: boolean;
    type: "faceId" | "touchId" | "none";
  }> {
    // Web Authentication API could potentially support this,
    // but for now we just return not available
    return { available: false, type: "none" };
  }

  /**
   * Store with biometric protection - falls back to regular storage in web
   */
  async setBiometric(
    options: KeychainSetOptions & { promptMessage: string }
  ): Promise<void> {
    console.warn(
      "Biometric storage not available in web mode, using regular storage"
    );
    await this.set(options);
  }

  /**
   * Get with biometric protection - falls back to regular storage in web
   */
  async getBiometric(
    options: KeychainGetOptions & { promptMessage: string }
  ): Promise<KeychainGetResult> {
    console.warn(
      "Biometric storage not available in web mode, using regular storage"
    );
    return this.get(options);
  }
}
