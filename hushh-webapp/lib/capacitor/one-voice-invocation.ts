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
import type { TranscriptEvent } from "@/lib/voice/transcript-events";
import type { VoiceModelPackManifest } from "@/lib/voice/local-runtime-contract";
import type {
  CommandRecording,
  CommandCapturePermission,
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

export type NativeFluidAudioPackPreparation = {
  ready: boolean;
  packId?: string;
  version?: string;
  reason?: string;
};

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
  addListener(
    eventName: "voiceInvocationAvailable",
    listener: (invocation: PendingOneVoiceInvocation) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "systemActionInvocationAvailable",
    listener: (invocation: PendingOneSystemActionInvocation) => void,
  ): Promise<PluginListenerHandle>;
  // Siri free-text request capture. These live on the SAME native plugin
  // (HushhVoiceInvocationPlugin, jsName "HushhVoiceInvocation"), so they must be
  // declared on the one registration -- Capacitor refuses a second
  // registerPlugin for the same name and hands back the first proxy, which
  // would leave these methods undefined on web.
  getPendingRequestInvocation(): Promise<Record<string, unknown>>;
  claimRequestInvocation(options: {
    id: string;
  }): Promise<{ claimed: boolean }>;
  completeRequestInvocation(options: Record<string, unknown>): Promise<void>;
  reportRequestInvocationProgress(
    options: Record<string, unknown>,
  ): Promise<{ reported: boolean }>;
  cancelRequestInvocation(options?: { id?: string }): Promise<void>;
  prepareFluidAudioModelPack(options: {
    packId: string;
    version: string;
    sizeBytes: number;
    checksum: string;
    artifactUrl: string;
    entrypoint: string;
    licenseNoticeId: string;
    licenseApproved: boolean;
  }): Promise<NativeFluidAudioPackPreparation>;
  getFluidAudioAvailability(): Promise<{ available: boolean }>;
  rollbackFluidAudioModelPack(): Promise<{ rolledBack: boolean }>;
  startSpeechRecognition(options?: {
    sessionId?: string;
    locale?: string;
    onDevice?: boolean;
    allowNetwork?: boolean;
    contextualStrings?: readonly string[];
    provider?: "apple_speech" | "fluid_audio";
  }): Promise<{
    sessionId: string;
    provider: string;
    onDevice: boolean;
  }>;
  stopSpeechRecognition(options?: { sessionId?: string }): Promise<void>;
  addListener(
    eventName: "systemRequestInvocationAvailable",
    listener: (invocation: unknown) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "oneTranscript",
    listener: (event: TranscriptEvent) => void,
  ): Promise<PluginListenerHandle>;
}

class OneVoiceInvocationWeb extends WebPlugin {
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

  async claimRequestInvocation(): Promise<{ claimed: boolean }> {
    return { claimed: false };
  }

  async completeRequestInvocation(): Promise<void> {}

  async reportRequestInvocationProgress(): Promise<{ reported: boolean }> {
    return { reported: false };
  }

  async cancelRequestInvocation(_options?: { id?: string }): Promise<void> {}

  async prepareFluidAudioModelPack(): Promise<NativeFluidAudioPackPreparation> {
    return { ready: false, reason: "speech_unsupported" };
  }

  async getFluidAudioAvailability(): Promise<{ available: boolean }> {
    return { available: false };
  }

  async rollbackFluidAudioModelPack(): Promise<{ rolledBack: boolean }> {
    return { rolledBack: false };
  }

  async startSpeechRecognition(): Promise<{
    sessionId: string;
    provider: string;
    onDevice: boolean;
  }> {
    throw new Error("speech_unsupported");
  }

  async stopSpeechRecognition(): Promise<void> {}
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
    if (!this.isSupported()) return { remove: async () => undefined };
    return NativeOneVoiceInvocation.addListener(
      "voiceInvocationAvailable",
      listener,
    );
  },

  async startSpeechRecognition(
    options: {
      sessionId?: string;
      locale?: string;
      onDevice?: boolean;
      allowNetwork?: boolean;
      contextualStrings?: readonly string[];
      provider?: "apple_speech" | "fluid_audio";
    } = {},
  ): Promise<{
    sessionId: string;
    provider: string;
    onDevice: boolean;
  }> {
    if (!this.isSupported()) throw new Error("speech_unsupported");
    return NativeOneVoiceInvocation.startSpeechRecognition(options);
  },

  async stopSpeechRecognition(
    options: { sessionId?: string } = {},
  ): Promise<void> {
    if (!this.isSupported()) return;
    await NativeOneVoiceInvocation.stopSpeechRecognition(options);
  },

  async prepareFluidAudioModelPack(
    pack: VoiceModelPackManifest,
  ): Promise<NativeFluidAudioPackPreparation> {
    if (!this.isSupported())
      return { ready: false, reason: "speech_unsupported" };
    if (pack.runtime !== "fluid_audio") {
      return { ready: false, reason: "pack_not_compatible" };
    }
    return NativeOneVoiceInvocation.prepareFluidAudioModelPack({
      packId: pack.pack_id,
      version: pack.version,
      sizeBytes: pack.size_bytes,
      checksum: pack.checksum,
      artifactUrl: pack.artifact_url,
      entrypoint: pack.entrypoint,
      licenseNoticeId: pack.license_notice_id,
      licenseApproved: pack.license_approved,
    });
  },

  async getFluidAudioAvailability(): Promise<boolean> {
    if (!this.isSupported()) return false;
    return (
      (await NativeOneVoiceInvocation.getFluidAudioAvailability()).available ===
      true
    );
  },

  async rollbackFluidAudioModelPack(): Promise<boolean> {
    if (!this.isSupported()) return false;
    return (
      (await NativeOneVoiceInvocation.rollbackFluidAudioModelPack())
        .rolledBack === true
    );
  },

  async addTranscriptListener(
    listener: (event: TranscriptEvent) => void,
  ): Promise<PluginListenerHandle> {
    if (!this.isSupported()) return { remove: async () => undefined };
    return NativeOneVoiceInvocation.addListener("oneTranscript", listener);
  },
};
