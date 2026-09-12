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
import type {
  CommandCapturePermission,
  CommandRecording,
} from "@/lib/voice/command-capture";

export type PendingOneVoiceInvocation = {
  id: string;
  kind: "start_one_voice";
  source: "siri_app_shortcut";
  createdAt: number;
  expiresAt: number;
  handoffDeadlineAt: number;
  claimedAt?: number | null;
  appOwnedAt?: number | null;
  detached?: boolean;
  outcome?: string | null;
};

export type OneVoiceInvocationOutcome =
  | "accepted"
  | "failed"
  | "expired"
  | "cancelled"
  | "fallback_shown"
  | "handoff_timeout";

export type OneVoiceInvocationProgressState =
  "claimed" | "app_owned" | "detached";

export interface NativeOneVoiceInvocationPlugin {
  getCommandCapturePermission(): Promise<CommandCapturePermission>;
  requestCommandCapturePermission(): Promise<CommandCapturePermission>;
  openCommandCaptureSettings(): Promise<{ opened: boolean }>;
  startCommandCapture(options: {
    sessionId: string;
    maxDurationMs: number;
    requestedAtMs: number;
  }): Promise<{ sessionId: string }>;
  finishCommandCapture(options: {
    sessionId: string;
  }): Promise<CommandRecording>;
  cancelCommandCapture(options: {
    sessionId: string;
  }): Promise<{ cancelled: boolean }>;
  getPendingInvocation(): Promise<Partial<PendingOneVoiceInvocation>>;
  claimInvocation(options: { id: string }): Promise<{ claimed: boolean }>;
  reportInvocationProgress(options: {
    id: string;
    state: OneVoiceInvocationProgressState;
  }): Promise<{ reported: boolean }>;
  completeInvocation(options: {
    id: string;
    outcome: OneVoiceInvocationOutcome;
  }): Promise<void>;
  getPendingActionInvocation(): Promise<
    Partial<PendingOneSystemActionInvocation>
  >;
  claimActionInvocation(options: { id: string }): Promise<{ claimed: boolean }>;
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
  getPendingRequestInvocation(): Promise<Record<string, unknown>>;
  claimRequestInvocation(options: {
    id: string;
  }): Promise<{ claimed: boolean; requestText?: string }>;
  completeRequestInvocation(options: Record<string, unknown>): Promise<void>;
  reportRequestInvocationProgress(options: Record<string, unknown>): Promise<{
    reported: boolean;
  }>;
  cancelRequestInvocation(options?: { id?: string }): Promise<void>;
  addListener(
    eventName: "voiceInvocationAvailable",
    listener: (invocation: PendingOneVoiceInvocation) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "systemActionInvocationAvailable",
    listener: (invocation: PendingOneSystemActionInvocation) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "systemRequestInvocationAvailable",
    listener: (invocation: unknown) => void,
  ): Promise<PluginListenerHandle>;
}

const noListener = (): PluginListenerHandle => ({
  remove: async () => undefined,
});

class OneVoiceInvocationWeb extends WebPlugin {
  async getCommandCapturePermission(): Promise<CommandCapturePermission> {
    // Web capture uses getUserMedia directly; this native bridge is never its
    // authority. Return a closed native-shaped result for accidental callers.
    return { state: "denied", sourcePlatform: "ios" };
  }

  async requestCommandCapturePermission(): Promise<CommandCapturePermission> {
    return this.getCommandCapturePermission();
  }

  async openCommandCaptureSettings(): Promise<{ opened: boolean }> {
    return { opened: false };
  }

  async startCommandCapture(): Promise<{ sessionId: string }> {
    throw new Error("native_command_capture_unsupported");
  }

  async finishCommandCapture(): Promise<CommandRecording> {
    throw new Error("native_command_capture_unsupported");
  }

  async cancelCommandCapture(): Promise<{ cancelled: boolean }> {
    return { cancelled: false };
  }

  async getPendingInvocation(): Promise<Record<string, never>> {
    return {};
  }

  async claimInvocation(): Promise<{ claimed: boolean }> {
    return { claimed: false };
  }

  async reportInvocationProgress(): Promise<{ reported: boolean }> {
    return { reported: false };
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

  async getPendingRequestInvocation(): Promise<Record<string, never>> {
    return {};
  }

  async claimRequestInvocation(): Promise<{
    claimed: boolean;
    requestText?: string;
  }> {
    return { claimed: false };
  }

  async completeRequestInvocation(): Promise<void> {}

  async reportRequestInvocationProgress(): Promise<{ reported: boolean }> {
    return { reported: false };
  }

  async cancelRequestInvocation(): Promise<void> {}
}

export const NativeOneVoiceInvocation =
  registerPlugin<NativeOneVoiceInvocationPlugin>("HushhVoiceInvocation", {
    web: () => Promise.resolve(new OneVoiceInvocationWeb()),
  });

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
    Number.isFinite(value.expiresAt) &&
    typeof value.handoffDeadlineAt === "number" &&
    Number.isFinite(value.handoffDeadlineAt)
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

  async reportProgress(options: {
    id: string;
    state: OneVoiceInvocationProgressState;
  }): Promise<{ reported: boolean }> {
    if (!this.isSupported()) return { reported: false };
    return NativeOneVoiceInvocation.reportInvocationProgress(options);
  },

  async addAvailabilityListener(
    listener: (invocation: PendingOneVoiceInvocation) => void,
  ): Promise<PluginListenerHandle> {
    if (!this.isSupported()) return noListener();
    return NativeOneVoiceInvocation.addListener(
      "voiceInvocationAvailable",
      listener,
    );
  },
};
