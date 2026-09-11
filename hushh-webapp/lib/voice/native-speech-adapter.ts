import type { PluginListenerHandle } from "@capacitor/core";

import { OneVoiceInvocationBridge } from "@/lib/capacitor/one-voice-invocation";
import type { VoiceModelPackManifest } from "./local-runtime-contract";
import {
  chooseNativeFluidAudioPack,
  fetchLocalRuntimeCapability,
} from "./local-runtime-capability";
import { emitLocalRuntimeEvent } from "./local-runtime-observability";
import { buildSpeechContextualStrings } from "./speech-contextual-strings";
import { getVoiceV2Flags } from "./voice-feature-flags";
import {
  createSpeechSessionId,
  type OneVoiceSpeechAdapter,
  type SpeechAdapterCallbacks,
  type SpeechAdapterStartOptions,
  type SpeechAdapterStartResult,
} from "./transcript-events";

/** iOS native Speech adapter. It shares the same transcript contract as web. */
export class NativeSpeechAdapter implements OneVoiceSpeechAdapter {
  private activeProvider = "apple_speech";
  private sessionId: string | null = null;
  private transcriptListener: PluginListenerHandle | null = null;
  private callbacks: SpeechAdapterCallbacks;
  private deviceRecognition = false;

  constructor(callbacks: SpeechAdapterCallbacks) {
    this.callbacks = callbacks;
  }

  setCallbacks(callbacks: SpeechAdapterCallbacks): void {
    this.callbacks = callbacks;
  }

  get onDevice(): boolean {
    return this.deviceRecognition;
  }

  get provider(): string {
    return this.activeProvider;
  }

  async start(
    options: SpeechAdapterStartOptions = {},
  ): Promise<SpeechAdapterStartResult> {
    if (!OneVoiceInvocationBridge.isSupported()) {
      throw new Error("speech_unsupported");
    }
    await this.removeTranscriptListener();
    this.sessionId = options.sessionId || createSpeechSessionId("ios_voice");
    this.transcriptListener = await OneVoiceInvocationBridge.addTranscriptListener(
      (event) => {
        if (event.sessionId !== this.sessionId) return;
        this.callbacks.onEvent(event);
      },
    );
    const shouldRequestFluidAudio =
      getVoiceV2Flags().nativeFluidAudioEnabled;
    try {
      const result = await OneVoiceInvocationBridge.startSpeechRecognition({
        sessionId: this.sessionId,
        locale: options.locale,
        onDevice: options.onDevice ?? true,
        allowNetwork: options.allowNetwork ?? false,
        contextualStrings:
          options.contextualStrings ?? buildSpeechContextualStrings(),
        // The native plugin starts FluidAudio only when an already verified
        // local pack is active. Otherwise it begins Apple Speech immediately
        // and returns that actual provider; a background warm-up must never
        // delay microphone capture or masquerade as on-device FluidAudio.
        provider: shouldRequestFluidAudio ? "fluid_audio" : "apple_speech",
      });
      this.sessionId = result.sessionId;
      this.deviceRecognition = result.onDevice;
      this.activeProvider = result.provider;
      if (shouldRequestFluidAudio && result.provider !== "fluid_audio") {
        void warmNativeFluidAudioPack();
      }
      return result;
    } catch (error) {
      await this.removeTranscriptListener();
      this.sessionId = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.sessionId) {
      await OneVoiceInvocationBridge.stopSpeechRecognition({
        sessionId: this.sessionId,
      });
    }
    await this.removeTranscriptListener();
    this.sessionId = null;
    this.deviceRecognition = false;
    this.activeProvider = "apple_speech";
  }

  async cancel(): Promise<void> {
    await this.stop();
  }

  private async removeTranscriptListener(): Promise<void> {
    const listener = this.transcriptListener;
    this.transcriptListener = null;
    if (listener) await listener.remove();
  }
}

/**
 * Starts the reviewed on-demand native model-pack path. Callers obtain the
 * current pack only from the capability endpoint; the bridge keeps the
 * short-lived signed URL out of durable native storage.
 */
export async function prepareNativeFluidAudioPack(
  pack: VoiceModelPackManifest,
): Promise<boolean> {
  const result = await OneVoiceInvocationBridge.prepareFluidAudioModelPack(pack);
  return result.ready === true;
}

async function warmNativeFluidAudioPack(): Promise<void> {
  // Each attempt obtains a new capability response, therefore a failed or
  // expired short-lived URL is never reused. This work has no microphone,
  // transcript, action, or consent authority and can only prepare a future
  // session after native policy independently approves it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const capability = await fetchLocalRuntimeCapability();
      const pack = chooseNativeFluidAudioPack(capability);
      if (!pack) return;
      const ready = await prepareNativeFluidAudioPack(pack);
      emitLocalRuntimeEvent({
        event: ready ? "model_pack_activation_completed" : "model_pack_download_failed",
        packId: pack.pack_id,
        packVersion: pack.version,
        provider: "fluid_audio",
        reason: ready ? undefined : "native_pack_unavailable",
      });
      if (ready) return;
    } catch {
      // The only diagnostic is a bounded category. Do not record the signed
      // URL, text, audio, or application context that led to this session.
      emitLocalRuntimeEvent({
        event: "model_pack_download_failed",
        provider: "fluid_audio",
        reason: "native_pack_refresh_failed",
      });
    }
  }
}
