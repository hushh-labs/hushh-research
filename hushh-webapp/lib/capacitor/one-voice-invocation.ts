"use client";

import {
  Capacitor,
  WebPlugin,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import type {
  OneSystemActionOutcome,
  OneSystemEntityIndexEntry,
  PendingOneSystemActionInvocation,
} from "@/lib/capacitor/one-system-action-invocation";

export type PendingOneVoiceInvocation = {
  id: string;
  kind: "start_one_voice";
  source: "siri_app_shortcut";
  createdAt: number;
  expiresAt: number;
};

export type OneVoiceInvocationOutcome =
  "accepted" | "failed" | "expired" | "cancelled" | "fallback_shown";

export interface NativeOneVoiceInvocationPlugin {
  getPendingInvocation(): Promise<Partial<PendingOneVoiceInvocation>>;
  claimInvocation(options: { id: string }): Promise<{ claimed: boolean }>;
  completeInvocation(options: {
    id: string;
    outcome: OneVoiceInvocationOutcome;
  }): Promise<void>;
  getPendingActionInvocation(): Promise<
    Partial<PendingOneSystemActionInvocation>
  >;
  claimActionInvocation(options: {
    id: string;
  }): Promise<{ claimed: boolean }>;
  completeActionInvocation(options: {
    id: string;
    outcome: OneSystemActionOutcome;
    summary: string;
  }): Promise<void>;
  reportActionInvocationProgress(options: {
    id: string;
    state: "waiting_for_vault";
  }): Promise<{ reported: boolean }>;
  updateActionEntityIndex(options: {
    ownerId: string;
    contacts: OneSystemEntityIndexEntry[];
    circles: OneSystemEntityIndexEntry[];
  }): Promise<{ updated: boolean }>;
  clearActionState(options: {
    outcome: "cancelled" | "sign_out";
    clearEntityIndex: boolean;
  }): Promise<void>;
  addListener(
    eventName: "voiceInvocationAvailable",
    listener: (invocation: PendingOneVoiceInvocation) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "systemActionInvocationAvailable",
    listener: (invocation: PendingOneSystemActionInvocation) => void,
  ): Promise<PluginListenerHandle>;
}

class OneVoiceInvocationWeb extends WebPlugin {
  async getPendingInvocation(): Promise<Record<string, never>> {
    return {};
  }

  async claimInvocation(): Promise<{ claimed: boolean }> {
    return { claimed: false };
  }

  async completeInvocation(): Promise<void> {}

  async getPendingActionInvocation(): Promise<Record<string, never>> {
    return {};
  }

  async claimActionInvocation(): Promise<{ claimed: boolean }> {
    return { claimed: false };
  }

  async completeActionInvocation(): Promise<void> {}

  async reportActionInvocationProgress(): Promise<{ reported: boolean }> {
    return { reported: false };
  }

  async updateActionEntityIndex(): Promise<{ updated: boolean }> {
    return { updated: false };
  }

  async clearActionState(): Promise<void> {}
}

export const NativeOneVoiceInvocation =
  registerPlugin<NativeOneVoiceInvocationPlugin>(
  "HushhVoiceInvocation",
  { web: () => Promise.resolve(new OneVoiceInvocationWeb()) },
);

function isPendingInvocation(
  value: Partial<PendingOneVoiceInvocation> | null | undefined,
): value is PendingOneVoiceInvocation {
  return (
    value?.kind === "start_one_voice" &&
    value.source === "siri_app_shortcut" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt)
  );
}

export const OneVoiceInvocationBridge = {
  isSupported(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  },

  async getPendingInvocation(): Promise<PendingOneVoiceInvocation | null> {
    if (!this.isSupported()) return null;
    const invocation = await NativeOneVoiceInvocation.getPendingInvocation();
    return isPendingInvocation(invocation) ? invocation : null;
  },

  async claimInvocation(options: {
    id: string;
  }): Promise<{ claimed: boolean }> {
    if (!this.isSupported()) return { claimed: false };
    return NativeOneVoiceInvocation.claimInvocation(options);
  },

  async completeInvocation(options: {
    id: string;
    outcome: OneVoiceInvocationOutcome;
  }): Promise<void> {
    if (!this.isSupported()) return;
    await NativeOneVoiceInvocation.completeInvocation(options);
  },

  async addAvailabilityListener(
    listener: (invocation: PendingOneVoiceInvocation) => void,
  ): Promise<PluginListenerHandle> {
    if (!this.isSupported()) return { remove: async () => undefined };
    return NativeOneVoiceInvocation.addListener(
      "voiceInvocationAvailable",
      listener,
    );
  },
};
