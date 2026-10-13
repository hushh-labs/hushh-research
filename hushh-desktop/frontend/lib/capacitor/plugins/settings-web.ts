/**
 * HushhSettingsWeb - Web implementation for settings
 * 
 * Uses localStorage for persistence on web platform.
 * Regulated cutover default: remote sync disabled.
 */

import type { HushhSettingsPlugin, HushhSettingsData } from "../index";

const STORAGE_KEY = "hushh_settings";

// Default settings
const DEFAULT_SETTINGS: HushhSettingsData = {
  useRemoteSync: false,
  syncOnWifiOnly: true,
  useRemoteLLM: true,               // DEV: true
  preferredLLMProvider: "openai",
  requireBiometricUnlock: true,
  autoLockTimeout: 5,
  theme: "system",
  hapticFeedback: true,
  showDebugInfo: true,              // DEV: true
  verboseLogging: true,             // DEV: true
};

export class HushhSettingsWeb implements HushhSettingsPlugin {
  private cachedSettings: HushhSettingsData | null = null;

  async getSettings(): Promise<HushhSettingsData> {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        this.cachedSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
      } else {
        this.cachedSettings = { ...DEFAULT_SETTINGS };
      }
    } catch {
      this.cachedSettings = { ...DEFAULT_SETTINGS };
    }

    return this.cachedSettings!;
  }

  async updateSettings(
    options: Partial<HushhSettingsData>
  ): Promise<{ success: boolean }> {
    const current = await this.getSettings();
    const updated = { ...current, ...options };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      this.cachedSettings = updated;
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  async resetSettings(): Promise<{ success: boolean }> {
    try {
      localStorage.removeItem(STORAGE_KEY);
      this.cachedSettings = { ...DEFAULT_SETTINGS };
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  async shouldUseLocalAgents(): Promise<{ value: boolean }> {
    const settings = await this.getSettings();
    return { value: !settings.useRemoteLLM };
  }

  async shouldSyncToCloud(): Promise<{ value: boolean }> {
    const settings = await this.getSettings();
    return { value: settings.useRemoteSync };
  }
}
