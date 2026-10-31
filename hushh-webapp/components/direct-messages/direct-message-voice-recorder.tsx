"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Send, X } from "@/components/icons";
import { CommandCapture } from "@/lib/voice/command-capture";
import { appInteractionCoordinator, type VoiceSessionLease } from "@/lib/interaction/interaction-intent-coordinator";
import { inspectVoiceMessage, formatVoiceDuration } from "@/lib/direct-messages/voice-message";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import styles from "./direct-messages-page.module.css";

export function DirectMessageVoiceRecorder({ disabled, onRecorded, onRecordingChange }: {
  disabled: boolean;
  onRecorded: (file: File) => void;
  onRecordingChange: (recording: boolean) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "finishing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const active = useRef(true);
  const generation = useRef(0);
  const capture = useRef<CommandCapture | null>(null);
  const reusableCapture = useRef<CommandCapture | null>(null);
  const lease = useRef<VoiceSessionLease | null>(null);
  const busy = useRef(false);
  const finishing = useRef(false);
  const startedAt = useRef(0);
  const onLimit = useRef<() => void>(() => undefined);
  useEffect(() => { onRecordingChange(phase !== "idle"); }, [onRecordingChange, phase]);

  const cancel = useCallback(() => {
    generation.current += 1;
    busy.current = false;
    finishing.current = false;
    void capture.current?.cancel();
    capture.current = null;
    lease.current?.release("recording_cancelled");
    lease.current = null;
    if (active.current) { onRecordingChange(false); setPhase("idle"); setElapsed(0); }
  }, [onRecordingChange]);

  useEffect(() => {
    active.current = true;
    const onVisibility = () => { if (document.visibilityState !== "visible" || appInteractionCoordinator.getLifecycleSnapshot().state !== "active") cancel(); };
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = appInteractionCoordinator.subscribeLifecycle(onVisibility);
    return () => {
      active.current = false;
      cancel();
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
    };
  }, [cancel]);
  useEffect(() => { if (disabled) cancel(); }, [disabled, cancel]);
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const finish = async () => {
    if (!capture.current || !lease.current?.isCurrent() || phase !== "recording" || finishing.current) return;
    finishing.current = true;
    const current = generation.current;
    setPhase("finishing");
    try {
      const recording = await capture.current.finish();
      if (!active.current || current !== generation.current || !lease.current?.isCurrent()) return;
      const bytes = Uint8Array.from(atob(recording.audioBase64), char => char.charCodeAt(0));
      inspectVoiceMessage(bytes);
      const file = new File([bytes], "Voice message.wav", { type: "audio/wav" });
      cancel();
      onRecorded(file);
    } catch (error) {
      if (active.current && current === generation.current) {
        cancel();
        morphyToast.error(error instanceof Error ? error.message : "The voice message could not be recorded.");
      }
    }
  };
  useEffect(() => { onLimit.current = () => void finish(); });

  const start = async () => {
    if (disabled || busy.current) return;
    busy.current = true;
    const current = ++generation.current;
    // Keep granted web permission across retries on browsers without the
    // Permissions API. A still-pending capture is never reused concurrently.
    const recorder = reusableCapture.current ?? new CommandCapture();
    reusableCapture.current = null;
    capture.current = recorder;
    lease.current = appInteractionCoordinator.acquireVoiceLease({ owner: "direct-message-recording", onRevoked: cancel });
    onRecordingChange(true); setPhase("starting");
    try {
      await recorder.start(crypto.randomUUID(), () => onLimit.current(), undefined, () => {
        if (!active.current || current !== generation.current) return;
        cancel();
        morphyToast.error("The microphone disconnected. Record your message again.");
      });
      if (!active.current || current !== generation.current || !lease.current?.isCurrent()) {
        return; // Cancellation already fenced this session; never cancel a newer retry.
      }
      reusableCapture.current = recorder;
      startedAt.current = Date.now(); setElapsed(0); setPhase("recording");
    } catch (error) {
      if (active.current && current === generation.current) {
        cancel();
        const message = error instanceof Error ? error.message : "The microphone could not be opened.";
        if (message.includes("Microphone permission updated")) reusableCapture.current = recorder;
        morphyToast.error(message.includes("Microphone permission updated")
          ? "Microphone enabled. Tap the mic again to record." : message);
      }
    }
  };

  return phase === "idle" ? <button type="button" className={styles.voiceButton}
    disabled={disabled} aria-label="Record voice message" onClick={() => void start()}>
    <Mic className="h-5 w-5" aria-hidden="true" />
  </button> : <div className={styles.recordingControls} role="group" aria-label="Voice recording">
    <span role="status">{phase === "starting" ? "Starting…" : phase === "finishing" ? "Finishing…" : formatVoiceDuration(elapsed)}</span>
    <button type="button" className={styles.voiceButton} aria-label="Cancel recording" onClick={cancel}><X className="h-5 w-5" aria-hidden="true" /></button>
    <button type="button" className={styles.sendButton} aria-label="Send voice message" disabled={phase !== "recording"} onClick={() => void finish()}><Send className="h-5 w-5" aria-hidden="true" /></button>
  </div>;
}
