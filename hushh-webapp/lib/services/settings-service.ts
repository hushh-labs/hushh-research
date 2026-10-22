"use client";

/**
 * Hussh Settings Service
 *
 * Manages user preferences for local vs remote operation.
 *
 * Regulated cutover defaults: remote sync disabled by default.
 */

import { Preferences } from "@capacitor/preferences";
import { readAppHapticPreference, writeAppHapticPreference, usesNativeHapticPreference } from "@/lib/capacitor/app-haptics";

// ==================== Settings Types ====================

export interface HushhSettings {
  // Data Storage Mode
  useRemoteSync: boolean; // Regulated default: false
  syncOnWifiOnly: boolean;

  // LLM Processing Mode
  useRemoteLLM: boolean; // DEV: true, PROD: false
  preferredLLMProvider: "local" | "mlx" | "openai" | "anthropic" | "google";

  // Security
  requireBiometricUnlock: boolean;

  // UI Preferences
  theme: "system" | "light" | "dark";
  hapticFeedback: boolean;

  // Developer/Debug
  showDebugInfo: boolean;
  verboseLogging: boolean;
}

// ==================== Default Settings ====================
export const DEFAULT_SETTINGS: HushhSettings = {
  // Regulated cutover default: remote sync disabled.
  useRemoteSync: false,
  syncOnWifiOnly: true,

  // Remote LLM remains enabled in current release.
  useRemoteLLM: true,
  preferredLLMProvider: "openai",

  // Security defaults
  requireBiometricUnlock: true,

  // UI defaults
  theme: "system",
  hapticFeedback: true,

  // Debug on for dev
  showDebugInfo: true,
  verboseLogging: true,
};

// ==================== Production Defaults (for reference) ====================
export const PRODUCTION_SETTINGS: HushhSettings = {
  useRemoteSync: false,
  syncOnWifiOnly: true,
  useRemoteLLM: false,
  preferredLLMProvider: "local", // or 'mlx' when ready
  requireBiometricUnlock: true,
  theme: "system",
  hapticFeedback: true,
  showDebugInfo: false,
  verboseLogging: false,
};

// ==================== Settings Service ====================

class SettingsServiceImpl {
  private static STORAGE_KEY = "hushh_settings";
  private cachedSettings: HushhSettings | null = null;
  private loading: Promise<HushhSettings> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private listeners: Set<(settings: HushhSettings) => void> = new Set();

  /**
   * Get current settings (cached for performance)
   */
  async getSettings(): Promise<HushhSettings> {
    if (this.loading) return this.loading;
    if (this.cachedSettings) {
      return this.cachedSettings;
    }
    this.loading = this.loadSettings();
    try { return await this.loading; } finally { this.loading = null; }
  }

  private async loadSettings(): Promise<HushhSettings> {
    let settings: HushhSettings;
    try {
      const { value } = await Preferences.get({
        key: SettingsServiceImpl.STORAGE_KEY,
      });
      if (value) {
        settings = { ...DEFAULT_SETTINGS, ...JSON.parse(value) };
      } else {
        settings = { ...DEFAULT_SETTINGS };
      }
    } catch {
      console.warn("SETTINGS_READ_FAILED");
      settings = { ...DEFAULT_SETTINGS };
    }

    if (usesNativeHapticPreference()) {
      settings.hapticFeedback = await readAppHapticPreference().catch(() => false);
    }
    this.cachedSettings = settings;
    return settings;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.catch(() => undefined).then(operation);
    this.writes = result;
    return result;
  }

  /**
   * Update settings
   */
  async updateSettings(
    updates: Partial<HushhSettings>
  ): Promise<HushhSettings> {
    const snapshot = { ...updates };
    return this.enqueue(() => this.saveSettings(snapshot));
  }

  private async saveSettings(updates: Partial<HushhSettings>): Promise<HushhSettings> {
    const current = await this.getSettings();
    const updated = { ...current, ...updates };

    try {
      const { hapticFeedback, ...otherSettings } = updated;
      await Preferences.set({
        key: SettingsServiceImpl.STORAGE_KEY,
        value: JSON.stringify(usesNativeHapticPreference() ? otherSettings : updated),
      });
      if (usesNativeHapticPreference() && typeof updates.hapticFeedback === "boolean") await writeAppHapticPreference(hapticFeedback);
      this.cachedSettings = updated;

      // Notify listeners
      this.listeners.forEach((listener) => listener(updated));

      // Never log settings blobs or unfiltered plugin/provider errors.
    } catch (error) {
      console.warn("SETTINGS_SAVE_FAILED");
      throw error;
    }

    return updated;
  }

  /**
   * Reset to defaults
   */
  async resetSettings(): Promise<HushhSettings> {
    return this.enqueue(() => this.resetStoredSettings());
  }

  private async resetStoredSettings(): Promise<HushhSettings> {
    await Preferences.remove({ key: SettingsServiceImpl.STORAGE_KEY });
    if (usesNativeHapticPreference()) await writeAppHapticPreference(DEFAULT_SETTINGS.hapticFeedback);
    this.cachedSettings = { ...DEFAULT_SETTINGS };
    this.listeners.forEach((listener) => listener(this.cachedSettings!));
    return this.cachedSettings;
  }

  /**
   * Subscribe to settings changes
   */
  subscribe(listener: (settings: HushhSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ==================== Convenience Methods ====================

  /**
   * Check if should use local agents
   */
  async shouldUseLocalAgents(): Promise<boolean> {
    const settings = await this.getSettings();
    return !settings.useRemoteLLM;
  }

  /**
   * Check if should sync to cloud
   */
  async shouldSyncToCloud(): Promise<boolean> {
    const settings = await this.getSettings();
    return settings.useRemoteSync;
  }

  /**
   * Get LLM provider to use
   */
  async getLLMProvider(): Promise<
    "local" | "mlx" | "openai" | "anthropic" | "google"
  > {
    const settings = await this.getSettings();
    return settings.useRemoteLLM ? settings.preferredLLMProvider : "local";
  }
}

// Export singleton
export const SettingsService = new SettingsServiceImpl();

// ==================== React Hook ====================

import { useState, useEffect } from "react";

export function useSettings(): [
  HushhSettings | null,
  (updates: Partial<HushhSettings>) => Promise<void>
] {
  const [settings, setSettings] = useState<HushhSettings | null>(null);

  useEffect(() => {
    // Load initial settings
    SettingsService.getSettings().then(setSettings);

    // Subscribe to changes
    const unsubscribe = SettingsService.subscribe(setSettings);
    return unsubscribe;
  }, []);

  const updateSettings = async (updates: Partial<HushhSettings>) => {
    await SettingsService.updateSettings(updates);
  };

  return [settings, updateSettings];
}
