"use client";

import {
  Capacitor,
  type PluginListenerHandle,
} from "@capacitor/core";
import { NativeOneVoiceInvocation } from "@/lib/capacitor/one-voice-invocation";

export const ONE_SYSTEM_ACTION_IDS = [
  "location.open_now",
  "location.open_map",
  "location.open_active_shares",
  "location.open_shared_with_me",
  "location.open_needs_review",
  "location.open_settings",
  "location.open_temporary_link",
  "location.open_check_in",
  "location.open_sos",
  "location.open_sms_contacts",
  "location.share_selected",
  "location.send_request",
  "location.stop_share",
  "location.pause_updates",
  "location.resume_updates",
  "location.create_circle",
  "location.rename_circle",
] as const;

export type OneSystemActionId = (typeof ONE_SYSTEM_ACTION_IDS)[number];

export type PendingOneSystemActionInvocation = {
  id: string;
  kind: "execute_one_action";
  source: "siri_app_intent";
  actionId: OneSystemActionId;
  slots: Record<string, string>;
  requiresVault: boolean;
  confirmedBySystem: boolean;
  createdAt: number;
  expiresAt: number;
};

export type OneSystemActionOutcome =
  | "succeeded"
  | "started"
  | "blocked"
  | "failed"
  | "expired"
  | "cancelled";

export type OneSystemEntityIndexEntry = { id: string; name: string };

const actionIds = new Set<string>(ONE_SYSTEM_ACTION_IDS);

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      key.length > 0 && typeof item === "string" && item.length <= 160,
  );
}

export function isPendingOneSystemActionInvocation(
  value: Partial<PendingOneSystemActionInvocation> | null | undefined,
): value is PendingOneSystemActionInvocation {
  return (
    value?.kind === "execute_one_action" &&
    value.source === "siri_app_intent" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.actionId === "string" &&
    actionIds.has(value.actionId) &&
    isStringRecord(value.slots) &&
    typeof value.requiresVault === "boolean" &&
    typeof value.confirmedBySystem === "boolean" &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt)
  );
}

export const OneSystemActionInvocationBridge = {
  isSupported(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  },

  async getPendingInvocation(): Promise<PendingOneSystemActionInvocation | null> {
    if (!this.isSupported()) return null;
    const value = await NativeOneVoiceInvocation.getPendingActionInvocation();
    return isPendingOneSystemActionInvocation(value) ? value : null;
  },

  async claimInvocation(options: {
    id: string;
  }): Promise<{ claimed: boolean }> {
    if (!this.isSupported()) return { claimed: false };
    return NativeOneVoiceInvocation.claimActionInvocation(options);
  },

  async completeInvocation(options: {
    id: string;
    outcome: OneSystemActionOutcome;
    summary: string;
  }): Promise<void> {
    if (!this.isSupported()) return;
    await NativeOneVoiceInvocation.completeActionInvocation(options);
  },

  async updateEntityIndex(options: {
    ownerId: string;
    contacts: OneSystemEntityIndexEntry[];
    circles: OneSystemEntityIndexEntry[];
  }): Promise<boolean> {
    if (!this.isSupported()) return false;
    const result = await NativeOneVoiceInvocation.updateActionEntityIndex(options);
    return result.updated;
  },

  async clear(options: {
    outcome: "cancelled" | "sign_out";
    clearEntityIndex: boolean;
  }): Promise<void> {
    if (!this.isSupported()) return;
    await NativeOneVoiceInvocation.clearActionState(options);
  },

  async addAvailabilityListener(
    listener: (invocation: PendingOneSystemActionInvocation) => void,
  ): Promise<PluginListenerHandle> {
    if (!this.isSupported()) return { remove: async () => undefined };
    return NativeOneVoiceInvocation.addListener(
      "systemActionInvocationAvailable",
      listener,
    );
  },
};
