import { registerPlugin } from "@capacitor/core";

// ==================== HushhSettingsPlugin ====================
// Settings management - DEV defaults to remote

export interface HushhSettingsData {
  useRemoteSync: boolean;
  syncOnWifiOnly: boolean;
  useRemoteLLM: boolean;
  preferredLLMProvider: "local" | "mlx" | "openai" | "anthropic" | "google";
  requireBiometricUnlock: boolean;
  theme: "system" | "light" | "dark";
  hapticFeedback: boolean;
  showDebugInfo: boolean;
  verboseLogging: boolean;
}

export interface HushhSettingsPlugin {
  getFeedbackCapabilities(): Promise<{ interactionFeedback: boolean }>;
  interactionFeedback(options: {
    documentId: string;
    privacyGeneration: number;
    intentId: string;
    kind: "light" | "selection";
    issuedAtMs: number;
  }): Promise<{ accepted: boolean }>;
  getSettings(): Promise<HushhSettingsData>;
  updateSettings(
    options: Partial<HushhSettingsData>,
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
  },
);

