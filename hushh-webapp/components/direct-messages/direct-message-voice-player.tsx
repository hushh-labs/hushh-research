"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Play, Pause } from "@/components/icons";
import { appInteractionCoordinator, type VoiceSessionLease } from "@/lib/interaction/interaction-intent-coordinator";
import { inspectVoiceMessage, formatVoiceDuration } from "@/lib/direct-messages/voice-message";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import styles from "./direct-messages-page.module.css";

export function DirectMessageVoicePlayer({ durationMs, loadAudio }: {
  durationMs: number;
  loadAudio: () => Promise<Blob>;
}) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [speed, setSpeed] = useState(1);
  const audio = useRef<HTMLAudioElement | null>(null);
  const progress = useRef<SVGRectElement | null>(null);
  const lease = useRef<VoiceSessionLease | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const url = useRef<string | null>(null);
  const clipId = useId().replaceAll(":", "");

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && appInteractionCoordinator.getLifecycleSnapshot().state === "active") return;
      generation.current += 1; busy.current = false; setLoading(false);
      audio.current?.pause();
      lease.current?.release("playback_backgrounded"); lease.current = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = appInteractionCoordinator.subscribeLifecycle(onVisibility);
    return () => {
      generation.current += 1;
      const player = audio.current;
      if (player) {
        player.onplay = null; player.onpause = null; player.onended = null; player.ontimeupdate = null;
        player.pause(); player.src = "";
      }
      lease.current?.release("playback_unmounted");
      if (url.current) URL.revokeObjectURL(url.current);
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
    };
  }, []);

  const play = async () => {
    if (busy.current) return;
    if (audio.current && !audio.current.paused) { audio.current.pause(); return; }
    const current = generation.current;
    busy.current = true; setLoading(true);
    lease.current = appInteractionCoordinator.acquireVoiceLease({ owner: "direct-message-playback", onRevoked: () => {
      generation.current += 1; busy.current = false; setLoading(false);
      audio.current?.pause(); lease.current = null;
    } });
    try {
      if (!audio.current) {
        const blob = await loadAudio();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const waveform = inspectVoiceMessage(bytes);
        if (generation.current !== current || !lease.current?.isCurrent()) return;
        setPeaks(waveform.peaks);
        url.current = URL.createObjectURL(blob);
        const player = new Audio(url.current);
        audio.current = player;
        player.onplay = () => { if (!player.paused) setPlaying(true); };
        player.onpause = () => { if (!player.paused) return; setPlaying(false); lease.current?.release("playback_paused"); lease.current = null; };
        player.onended = () => { if (!player.ended) return; setPlaying(false); lease.current?.release("playback_ended"); lease.current = null; };
        // Update only the local SVG clip on media time events, never React per audio frame.
        player.ontimeupdate = () => progress.current?.setAttribute("transform", `scale(${Math.min(1, player.currentTime / (waveform.durationMs / 1000))} 1)`);
      }
      if (generation.current !== current || !lease.current?.isCurrent()) return;
      audio.current!.playbackRate = speed;
      await audio.current!.play();
    } catch {
      if (generation.current === current) {
        lease.current?.release("playback_failed"); lease.current = null;
        morphyToast.error("This voice message could not be played. Try again.");
      }
    } finally {
      if (generation.current === current) { busy.current = false; setLoading(false); }
    }
  };
  const path = peaks?.map((peak, index) => {
    const height = Math.max(2, peak * 28), x = index * 4 + 2;
    return `M${x} ${16 - height / 2}V${16 + height / 2}`;
  }).join(" ");

  return <div className={styles.voiceMessage}>
    <button type="button" className={styles.voicePlayButton} aria-label={playing ? "Pause voice message" : "Play voice message"}
      aria-busy={loading} disabled={loading} onClick={() => void play()}>
      {playing ? <Pause className="h-5 w-5" aria-hidden="true" /> : <Play className="h-5 w-5" aria-hidden="true" />}
    </button>
    <div className={styles.voiceWaveform}>
      <svg viewBox="0 0 128 32" aria-hidden="true">
        {path ? <><defs><clipPath id={clipId}><rect ref={progress} width="128" height="32" transform="scale(0 1)" /></clipPath></defs>
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d={path} fill="none" stroke="var(--chat-accent)" strokeWidth="2" strokeLinecap="round" clipPath={`url(#${clipId})`} /></>
          : <path d="M2 16H126" fill="none" stroke="currentColor" strokeWidth="2" />}
      </svg>
      <span>{formatVoiceDuration(durationMs)}</span>
    </div>
    <button type="button" className={styles.voiceSpeedButton} aria-label={`Playback speed ${speed}x`} onClick={() => {
      const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
      setSpeed(next); if (audio.current) audio.current.playbackRate = next;
    }}>{speed}x</button>
  </div>;
}
