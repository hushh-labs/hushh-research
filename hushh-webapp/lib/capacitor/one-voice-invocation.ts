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
  TranscriptEvent,
} from "@/lib/voice/transcript-events";
import type { VoiceModelPackManifest } from "@/lib/voice/local-runtime-contract";

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
  | "claimed"
  | "app_owned"
  | "detached";

export type NativeFluidAudioPackPreparation = {
  ready: boolean;
  packId?: string;
  version?: string;
  reason?: string;
};

/** The shared One Voice online-input contract for the iOS audio bridge. */
export type NativeRealtimeAudioEncoding = "pcm_s16le";

export type NativeRealtimeAudioCaptureStartResult = {
  sessionId: string;
  sampleRate: 16000;
  channels: 1;
  encoding: NativeRealtimeAudioEncoding;
  alreadyActive?: boolean;
};

export type NativeRealtimeAudioFrame = {
  sessionId: string;
  /** Opaque, monotonic packet sequence for the active capture session. */
  sequence: number;
  sampleRate: 16000;
  channels: 1;
  encoding: NativeRealtimeAudioEncoding;
  frameCount: number;
  level: number;
  /** Transient base64-encoded PCM16 little-endian bytes. Never persist it. */
  data: string;
};

export type NativeRealtimeAudioInputTurnEndResult = {
  sessionId: string;
  turnId: string;
  /** Last packet sequence that crossed the bridge before the native tail drained. */
  finalSequence: number;
  cancelled: boolean;
};

export type NativeRealtimeAudioStateName =
  | "started"
  | "stopped"
  | "error"
  | "first_frame"
  | "activity_started"
  | "activity_ended"
  | "delivery_backpressure"
  | "sequence_gap"
  | "turn_started"
  | "turn_ended"
  | "tail_drained";

export type NativeRealtimeAudioState = {
  sessionId: string;
  state: NativeRealtimeAudioStateName;
  errorCode?: string;
  timeToFirstFrameMs?: number;
  droppedFrames?: number;
  level?: number;
  turnId?: string;
  finalSequence?: number;
  cancelled?: boolean;
};

export interface NativeOneVoiceInvocationPlugin {
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
  // Siri free-text request capture. These live on the SAME native plugin
  // (HushhVoiceInvocationPlugin, jsName "HushhVoiceInvocation"), so they must be
  // declared on the one registration -- Capacitor refuses a second
  // registerPlugin for the same name and hands back the first proxy, which
  // would leave these methods undefined on web.
  getPendingRequestInvocation(): Promise<Record<string, unknown>>;
  claimRequestInvocation(options: { id: string }): Promise<{ claimed: boolean }>;
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
  startRealtimeAudioCapture(options?: {
    sessionId?: string;
    requiresExplicitTurn?: boolean;
  }): Promise<NativeRealtimeAudioCaptureStartResult>;
  stopRealtimeAudioCapture(options?: { sessionId?: string }): Promise<void>;
  beginRealtimeAudioInputTurn(options: {
    sessionId?: string;
    turnId: string;
  }): Promise<{ sessionId: string; turnId: string }>;
  endRealtimeAudioInputTurn(options: {
    sessionId?: string;
    turnId: string;
    cancelled?: boolean;
  }): Promise<NativeRealtimeAudioInputTurnEndResult>;
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
  addListener(
    eventName: "oneVoiceAudioFrame",
    listener: (event: NativeRealtimeAudioFrame) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "oneVoiceAudioState",
    listener: (event: NativeRealtimeAudioState) => void,
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

  async startRealtimeAudioCapture(): Promise<NativeRealtimeAudioCaptureStartResult> {
    throw new Error("native_audio_unsupported");
  }

  async stopRealtimeAudioCapture(): Promise<void> {}

  async beginRealtimeAudioInputTurn(): Promise<{
    sessionId: string;
    turnId: string;
  }> {
    throw new Error("native_audio_unsupported");
  }

  async endRealtimeAudioInputTurn(): Promise<NativeRealtimeAudioInputTurnEndResult> {
    throw new Error("native_audio_unsupported");
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
    Number.isFinite(value.expiresAt) &&
    typeof value.handoffDeadlineAt === "number" &&
    Number.isFinite(value.handoffDeadlineAt)
  );
}

function normalizeRealtimeAudioFrame(
  value: Partial<NativeRealtimeAudioFrame> | null | undefined,
): NativeRealtimeAudioFrame | null {
  if (!value || typeof value.sessionId !== "string" || !value.sessionId.trim()) {
    return null;
  }
  if (
    typeof value.sequence !== "number" ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 1 ||
    value.sampleRate !== 16000 ||
    value.channels !== 1 ||
    value.encoding !== "pcm_s16le" ||
    typeof value.frameCount !== "number" ||
    !Number.isInteger(value.frameCount) ||
    value.frameCount < 1 ||
    typeof value.level !== "number" ||
    !Number.isFinite(value.level) ||
    typeof value.data !== "string" ||
    value.data.length === 0 ||
    value.data.length > 32_768
  ) {
    return null;
  }
  return {
    sessionId: value.sessionId.trim(),
    sequence: value.sequence,
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
    frameCount: value.frameCount,
    level: Math.max(0, Math.min(1, value.level)),
    data: value.data,
  };
}

function normalizeRealtimeAudioCaptureStartResult(
  value: Partial<NativeRealtimeAudioCaptureStartResult> | null | undefined,
): NativeRealtimeAudioCaptureStartResult | null {
  if (
    !value ||
    typeof value.sessionId !== "string" ||
    !value.sessionId.trim() ||
    value.sampleRate !== 16000 ||
    value.channels !== 1 ||
    value.encoding !== "pcm_s16le"
  ) {
    return null;
  }
  return {
    sessionId: value.sessionId.trim(),
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
    ...(value.alreadyActive === true ? { alreadyActive: true } : {}),
  };
}

function normalizeRealtimeAudioState(
  value: Partial<NativeRealtimeAudioState> | null | undefined,
): NativeRealtimeAudioState | null {
  if (!value || typeof value.sessionId !== "string" || !value.sessionId.trim()) {
    return null;
  }
  const validStates: readonly NativeRealtimeAudioStateName[] = [
    "started",
    "stopped",
    "error",
    "first_frame",
    "activity_started",
    "activity_ended",
    "delivery_backpressure",
    "sequence_gap",
    "turn_started",
    "turn_ended",
    "tail_drained",
  ];
  if (!validStates.includes(value.state as NativeRealtimeAudioStateName)) {
    return null;
  }
  const state: NativeRealtimeAudioState = {
    sessionId: value.sessionId.trim(),
    state: value.state as NativeRealtimeAudioStateName,
  };
  if (typeof value.errorCode === "string" && value.errorCode.trim()) {
    state.errorCode = value.errorCode.trim().slice(0, 120);
  }
  if (
    typeof value.timeToFirstFrameMs === "number" &&
    Number.isFinite(value.timeToFirstFrameMs)
  ) {
    state.timeToFirstFrameMs = Math.max(0, Math.round(value.timeToFirstFrameMs));
  }
  if (
    typeof value.droppedFrames === "number" &&
    Number.isInteger(value.droppedFrames) &&
    value.droppedFrames > 0
  ) {
    state.droppedFrames = value.droppedFrames;
  }
  if (typeof value.level === "number" && Number.isFinite(value.level)) {
    state.level = Math.max(0, Math.min(1, value.level));
  }
  if (typeof value.turnId === "string" && value.turnId.trim()) {
    state.turnId = value.turnId.trim().slice(0, 128);
  }
  if (
    typeof value.finalSequence === "number" &&
    Number.isInteger(value.finalSequence) &&
    value.finalSequence >= 0
  ) {
    state.finalSequence = value.finalSequence;
  }
  if (value.cancelled === true) state.cancelled = true;
  return state;
}

function normalizeRealtimeAudioInputTurnEndResult(
  value: Partial<NativeRealtimeAudioInputTurnEndResult> | null | undefined,
): NativeRealtimeAudioInputTurnEndResult | null {
  if (
    !value ||
    typeof value.sessionId !== "string" ||
    !value.sessionId.trim() ||
    typeof value.turnId !== "string" ||
    !value.turnId.trim() ||
    typeof value.finalSequence !== "number" ||
    !Number.isInteger(value.finalSequence) ||
    value.finalSequence < 0 ||
    typeof value.cancelled !== "boolean"
  ) {
    return null;
  }
  return {
    sessionId: value.sessionId.trim(),
    turnId: value.turnId.trim(),
    finalSequence: value.finalSequence,
    cancelled: value.cancelled,
  };
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

  async startSpeechRecognition(options: {
    sessionId?: string;
    locale?: string;
    onDevice?: boolean;
    allowNetwork?: boolean;
    contextualStrings?: readonly string[];
    provider?: "apple_speech" | "fluid_audio";
  } = {}): Promise<{
    sessionId: string;
    provider: string;
    onDevice: boolean;
  }> {
    if (!this.isSupported()) throw new Error("speech_unsupported");
    return NativeOneVoiceInvocation.startSpeechRecognition(options);
  },

  async stopSpeechRecognition(options: { sessionId?: string } = {}): Promise<void> {
    if (!this.isSupported()) return;
    await NativeOneVoiceInvocation.stopSpeechRecognition(options);
  },

  async startRealtimeAudioCapture(options: {
    sessionId?: string;
    requiresExplicitTurn?: boolean;
  } = {}): Promise<NativeRealtimeAudioCaptureStartResult> {
    if (!this.isSupported()) throw new Error("native_audio_unsupported");
    const result = await NativeOneVoiceInvocation.startRealtimeAudioCapture(options);
    const normalized = normalizeRealtimeAudioCaptureStartResult(result);
    if (!normalized) throw new Error("native_audio_contract_invalid");
    return normalized;
  },

  async stopRealtimeAudioCapture(options: { sessionId?: string } = {}): Promise<void> {
    if (!this.isSupported()) return;
    await NativeOneVoiceInvocation.stopRealtimeAudioCapture(options);
  },

  async beginRealtimeAudioInputTurn(options: {
    sessionId?: string;
    turnId: string;
  }): Promise<{ sessionId: string; turnId: string }> {
    if (!this.isSupported()) throw new Error("native_audio_unsupported");
    const result = await NativeOneVoiceInvocation.beginRealtimeAudioInputTurn(options);
    if (
      !result ||
      typeof result.sessionId !== "string" ||
      !result.sessionId.trim() ||
      typeof result.turnId !== "string" ||
      !result.turnId.trim()
    ) {
      throw new Error("native_audio_turn_contract_invalid");
    }
    return { sessionId: result.sessionId.trim(), turnId: result.turnId.trim() };
  },

  async endRealtimeAudioInputTurn(options: {
    sessionId?: string;
    turnId: string;
    cancelled?: boolean;
  }): Promise<NativeRealtimeAudioInputTurnEndResult> {
    if (!this.isSupported()) throw new Error("native_audio_unsupported");
    const result = await NativeOneVoiceInvocation.endRealtimeAudioInputTurn(options);
    const normalized = normalizeRealtimeAudioInputTurnEndResult(result);
    if (!normalized) throw new Error("native_audio_turn_contract_invalid");
    return normalized;
  },

  async addRealtimeAudioFrameListener(
    listener: (event: NativeRealtimeAudioFrame) => void,
  ): Promise<PluginListenerHandle> {
    if (!this.isSupported()) return { remove: async () => undefined };
    return NativeOneVoiceInvocation.addListener("oneVoiceAudioFrame", (event) => {
      const normalized = normalizeRealtimeAudioFrame(event);
      if (normalized) listener(normalized);
    });
  },

  async addRealtimeAudioStateListener(
    listener: (event: NativeRealtimeAudioState) => void,
  ): Promise<PluginListenerHandle> {
    if (!this.isSupported()) return { remove: async () => undefined };
    return NativeOneVoiceInvocation.addListener("oneVoiceAudioState", (event) => {
      const normalized = normalizeRealtimeAudioState(event);
      if (normalized) listener(normalized);
    });
  },

  async prepareFluidAudioModelPack(
    pack: VoiceModelPackManifest,
  ): Promise<NativeFluidAudioPackPreparation> {
    if (!this.isSupported()) return { ready: false, reason: "speech_unsupported" };
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
    return (await NativeOneVoiceInvocation.getFluidAudioAvailability()).available === true;
  },

  async rollbackFluidAudioModelPack(): Promise<boolean> {
    if (!this.isSupported()) return false;
    return (await NativeOneVoiceInvocation.rollbackFluidAudioModelPack()).rolledBack === true;
  },

  async addTranscriptListener(
    listener: (event: TranscriptEvent) => void,
  ): Promise<PluginListenerHandle> {
    if (!this.isSupported()) return { remove: async () => undefined };
    return NativeOneVoiceInvocation.addListener("oneTranscript", listener);
  },
};
