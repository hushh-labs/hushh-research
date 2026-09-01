"use client";

import {
  Capacitor,
  WebPlugin,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";

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
  addListener(
    eventName: "voiceInvocationAvailable",
    listener: (invocation: PendingOneVoiceInvocation) => void,
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
}

const NativeOneVoiceInvocation = registerPlugin<NativeOneVoiceInvocationPlugin>(
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
