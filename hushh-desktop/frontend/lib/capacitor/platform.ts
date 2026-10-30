/**
 * Platform Detection Utilities for Hussh
 *
 * Detects whether running in:
 * - Native iOS (Capacitor)
 * - Native Android (Capacitor)
 * - Web browser (cloud mode)
 *
 * Use this to conditionally use native plugins vs API routes.
 */

import { Capacitor } from "@capacitor/core";

export type Platform = "ios" | "android" | "web";

/**
 * Get the current platform
 */
export function getPlatform(): Platform {
  return Capacitor.getPlatform() as Platform;
}

/**
 * Check if running in a native mobile app (iOS or Android)
 */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Check if running on iOS
 */
export function isIOS(): boolean {
  return Capacitor.getPlatform() === "ios";
}

/**
 * Check if running on Android
 */
export function isAndroid(): boolean {
  return Capacitor.getPlatform() === "android";
}

/**
 * Check if running in web browser
 */
export function isWeb(): boolean {
  return Capacitor.getPlatform() === "web";
}

/**
 * Check if a specific plugin is available on current platform
 */
export function isPluginAvailable(pluginName: string): boolean {
  return Capacitor.isPluginAvailable(pluginName);
}

/**
 * Convert a native path to a web-compatible URL
 * Useful for loading local resources in WebView
 */
export function convertFileSrc(filePath: string): string {
  return Capacitor.convertFileSrc(filePath);
}

/**
 * Configuration for platform-specific behavior
 */
export const platformConfig = {
  /**
   * Should use native plugins for consent/vault operations?
   * True on iOS/Android, false on web
   */
  useNativePlugins: isNative(),

  /**
   * Should use local SQLCipher database?
   * True on iOS/Android, false on web (uses cloud PostgreSQL)
   */
  useLocalDatabase: isNative(),

  /**
   * Should use iOS Keychain / Android Keystore?
   * True on native, false on web (uses sessionStorage fallback)
   */
  useSecureStorage: isNative(),

  /**
   * Base URL for API calls
   * Empty on native (calls go to native plugins)
   * Backend URL on web (calls go to cloud)
   */
  apiBaseUrl: isNative()
    ? ""
    : (process.env.NEXT_PUBLIC_BACKEND_URL || "").trim(),
};
