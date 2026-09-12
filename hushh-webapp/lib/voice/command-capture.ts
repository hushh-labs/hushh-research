"use client";

import { Capacitor } from "@capacitor/core";
import { NativeOneVoiceInvocation } from "@/lib/capacitor/one-voice-invocation";

export type CommandRecording = {
  sessionId: string;
  audioBase64: string;
  mimeType: "audio/wav";
  sampleRate: 16000;
  channels: 1;
  durationMs: number;
};
export type CommandCapturePermission = {
  state: "granted" | "prompt" | "denied";
  sourcePlatform: "ios" | "android";
};
/** One recording in memory. Cancel invalidates permission and worklet callbacks. */
export class CommandCapture {
  private session: string | null = null;
  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private rejectFinish: ((error: Error) => void) | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private finishing = false;

  async start(sessionId: string, onLimit: () => void): Promise<void> {
    if (this.session) throw new Error("The microphone is already in use.");
    this.session = sessionId;
    const requestedAtMs = Date.now();
    try {
      if (Capacitor.isNativePlatform()) {
        const permission =
          await NativeOneVoiceInvocation.getCommandCapturePermission();
        this.assertSession(sessionId);
        if (permission.state !== "granted") {
          if (permission.state === "denied")
            throw new Error("Allow microphone access in device settings.");
          await NativeOneVoiceInvocation.requestCommandCapturePermission();
          // A permission prompt outlives a hold gesture. Require a fresh gesture.
          throw new Error(
            "Microphone permission updated. Tap Talk to One to record.",
          );
        }
        this.assertSession(sessionId);
        await NativeOneVoiceInvocation.startCommandCapture({
          sessionId,
          maxDurationMs: 60_000,
          requestedAtMs,
        });
        if (this.session !== sessionId) {
          await NativeOneVoiceInvocation.cancelCommandCapture({ sessionId });
          throw new Error("Recording cancelled.");
        }
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true },
        });
        if (this.session !== sessionId) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error("Recording cancelled.");
        }
        this.stream = stream;
        const audio = new AudioContext();
        this.audio = audio;
        await audio.audioWorklet.addModule(
          "/audio/one-command-capture.worklet.js",
        );
        this.assertSession(sessionId);
        const node = new AudioWorkletNode(audio, "one-command-capture");
        this.node = node;
        audio.createMediaStreamSource(stream).connect(node);
        const silent = audio.createGain();
        silent.gain.value = 0;
        node.connect(silent).connect(audio.destination);
        await audio.resume();
        this.assertSession(sessionId);
      }
      this.limitTimer = setTimeout(() => {
        if (this.session === sessionId) onLimit();
      }, 60_000);
    } catch (error) {
      if (this.session === sessionId) await this.cancel();
      throw error;
    }
  }

  async finish(): Promise<CommandRecording> {
    const sessionId = this.session;
    if (!sessionId) throw new Error("No recording is active.");
    if (this.finishing) throw new Error("The recording is already finishing.");
    this.finishing = true;
    if (this.limitTimer) clearTimeout(this.limitTimer);
    try {
      let recording: CommandRecording;
      if (Capacitor.isNativePlatform()) {
        recording = await NativeOneVoiceInvocation.finishCommandCapture({
          sessionId,
        });
      } else {
        const node = this.node;
        if (!node)
          throw new Error(
            "The microphone is still starting. Please record again.",
          );
        const wav = await new Promise<ArrayBuffer>((resolve, reject) => {
          this.rejectFinish = reject;
          this.finishTimer = setTimeout(
            () => reject(new Error("Recording could not be finalized.")),
            3_000,
          );
          node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
            if (this.finishTimer) clearTimeout(this.finishTimer);
            resolve(event.data);
          };
          node.port.postMessage("finish");
        });
        this.assertSession(sessionId);
        const bytes = new Uint8Array(wav);
        if (bytes.length <= 44)
          throw new Error("No audio was captured. Please record again.");
        let binary = "";
        for (let index = 0; index < bytes.length; index += 8192) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        }
        recording = {
          sessionId,
          audioBase64: btoa(binary),
          mimeType: "audio/wav",
          sampleRate: 16000,
          channels: 1,
          durationMs: (bytes.length - 44) / 32,
        };
      }
      this.assertSession(sessionId);
      return recording;
    } finally {
      if (this.session === sessionId) {
        this.session = null;
        this.cleanup();
      }
    }
  }

  async cancel(): Promise<void> {
    const sessionId = this.session;
    this.session = null;
    this.rejectFinish?.(new Error("Recording cancelled."));
    this.cleanup();
    if (sessionId && Capacitor.isNativePlatform()) {
      await NativeOneVoiceInvocation.cancelCommandCapture({ sessionId }).catch(
        () => undefined,
      );
    }
  }

  private assertSession(id: string): void {
    if (this.session !== id) throw new Error("Recording cancelled.");
  }

  private cleanup(): void {
    this.finishing = false;
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    this.rejectFinish = null;
    this.node?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    this.node = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.audio?.close().catch(() => undefined);
    this.audio = null;
  }
}
