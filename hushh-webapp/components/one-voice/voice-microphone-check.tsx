"use client";

/**
 * "Test microphone" for Profile › Preferences › Voice.
 *
 * Three seconds of live level from the same capture path a session uses
 * (getUserMedia -> AudioWorklet -> 16 kHz PCM), then a one-second 440 Hz tone
 * through a local AudioContext so the output path is proven too. Nothing is
 * sent anywhere. The report (sample rate, echo cancellation, worklet loaded)
 * doubles as the iOS WebView spike artefact.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Mic, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import {
  LiveAudioCapture,
  describeMicError,
  probeMicrophone,
  type MicError,
  type MicrophoneProbe,
} from "@/lib/one-voice/audio/capture";
import { cn } from "@/lib/utils";

export const MIC_CHECK_METER_MS = 3000;
export const MIC_CHECK_TONE_MS = 1000;
export const MIC_CHECK_TONE_HZ = 440;
/** Below this peak the mic is open but silent — say so instead of "works". */
export const MIC_CHECK_HEARD_THRESHOLD = 0.02;

export type MicrophoneCheckPhase =
  "idle" | "probing" | "metering" | "tone" | "done" | "failed";

export type MicrophoneCheckReport = {
  sampleRate: number | null;
  echoCancellation: boolean | null;
  workletLoaded: boolean;
  peakLevel: number;
  heard: boolean;
  tonePlayed: boolean;
};

/** Capture surface the check drives; a session's LiveAudioCapture fits it. */
export type MicrophoneCheckCapture = {
  start: (options: {
    onFrame: (pcm16: Uint8Array) => void;
    onLevel?: (level: number) => void;
    audioContext?: AudioContext;
  }) => Promise<{ sampleRate: number; echoCancellation: boolean | null }>;
  stop: () => void;
};

export type VoiceMicrophoneCheckProps = {
  /** Injection points for tests and the native spike; defaults are the real audio path. */
  probe?: () => Promise<MicrophoneProbe>;
  createCapture?: () => MicrophoneCheckCapture;
  createAudioContext?: () => AudioContext | null;
  /** Sleep hook so tests can run the timeline synchronously. */
  wait?: (ms: number) => Promise<void>;
  onReport?: (report: MicrophoneCheckReport, error: MicError | null) => void;
  className?: string;
};

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function defaultCreateAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: AudioContextCtor })
      .webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Play a short sine tone on the context; resolves when it has ended. */
export async function playTestTone(
  context: AudioContext,
  durationMs = MIC_CHECK_TONE_MS,
  wait = defaultWait,
): Promise<boolean> {
  try {
    if (context.state === "suspended")
      await context.resume().catch(() => undefined);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = MIC_CHECK_TONE_HZ;
    gain.gain.value = 0.2;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + durationMs / 1000);
    await wait(durationMs);
    try {
      oscillator.disconnect();
      gain.disconnect();
    } catch {
      // ignore
    }
    return true;
  } catch {
    return false;
  }
}

export function formatSampleRate(rate: number | null): string {
  if (!rate || !Number.isFinite(rate)) return "Unknown";
  return `${new Intl.NumberFormat("en-US").format(Math.round(rate))} Hz`;
}

const INITIAL_REPORT: MicrophoneCheckReport = {
  sampleRate: null,
  echoCancellation: null,
  workletLoaded: false,
  peakLevel: 0,
  heard: false,
  tonePlayed: false,
};

export function VoiceMicrophoneCheck({
  probe = probeMicrophone,
  createCapture = () => new LiveAudioCapture(),
  createAudioContext = defaultCreateAudioContext,
  wait = defaultWait,
  onReport,
  className,
}: VoiceMicrophoneCheckProps) {
  const [phase, setPhase] = useState<MicrophoneCheckPhase>("idle");
  const [level, setLevel] = useState(0);
  const [report, setReport] = useState<MicrophoneCheckReport>(INITIAL_REPORT);
  const [error, setError] = useState<MicError | null>(null);
  const runningRef = useRef(false);
  const captureRef = useRef<MicrophoneCheckCapture | null>(null);
  const contextRef = useRef<AudioContext | null>(null);

  useEffect(
    () => () => {
      captureRef.current?.stop();
      captureRef.current = null;
      if (contextRef.current)
        void contextRef.current.close().catch(() => undefined);
      contextRef.current = null;
      runningRef.current = false;
    },
    [],
  );

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setError(null);
    setLevel(0);
    setReport(INITIAL_REPORT);
    setPhase("probing");
    const next: MicrophoneCheckReport = { ...INITIAL_REPORT };
    let failure: MicError | null = null;
    try {
      const probed = await probe();
      next.sampleRate = probed.sampleRate ?? null;
      next.echoCancellation = probed.echoCancellation ?? null;
      next.workletLoaded = probed.workletLoaded === true;
      if (!probed.ok) {
        failure = probed.error ?? {
          code: "unknown",
          message: "Voice could not start.",
        };
        return;
      }

      // Meter: the real capture path, from this tap's gesture.
      setPhase("metering");
      const context = createAudioContext();
      contextRef.current = context;
      const capture = createCapture();
      captureRef.current = capture;
      let peak = 0;
      const started = await capture.start({
        onFrame: () => undefined,
        onLevel: (value) => {
          const clamped = Number.isFinite(value)
            ? Math.min(1, Math.max(0, value))
            : 0;
          if (clamped > peak) peak = clamped;
          setLevel(clamped);
        },
        ...(context ? { audioContext: context } : {}),
      });
      next.sampleRate = started.sampleRate || next.sampleRate;
      if (started.echoCancellation !== null)
        next.echoCancellation = started.echoCancellation;
      await wait(MIC_CHECK_METER_MS);
      capture.stop();
      captureRef.current = null;
      next.peakLevel = peak;
      next.heard = peak >= MIC_CHECK_HEARD_THRESHOLD;
      setLevel(0);

      // Tone: prove the output path on the same context.
      setPhase("tone");
      next.tonePlayed = context
        ? await playTestTone(context, MIC_CHECK_TONE_MS, wait)
        : false;
    } catch (caught) {
      failure = describeMicError(caught);
    } finally {
      captureRef.current?.stop();
      captureRef.current = null;
      if (contextRef.current)
        void contextRef.current.close().catch(() => undefined);
      contextRef.current = null;
      runningRef.current = false;
      setReport(next);
      setError(failure);
      setPhase(failure ? "failed" : "done");
      onReport?.(next, failure);
    }
  }, [createAudioContext, createCapture, onReport, probe, wait]);

  const busy = phase === "probing" || phase === "metering" || phase === "tone";
  const label =
    phase === "probing"
      ? "Checking…"
      : phase === "metering"
        ? "Say something"
        : phase === "tone"
          ? "Playing tone"
          : "Test microphone";
  const success = roleClasses("success");
  const danger = roleClasses("danger");
  const warning = roleClasses("warning");
  const percent = Math.round(Math.min(1, Math.max(0, level)) * 100);

  return (
    <div
      data-testid="one-voice-microphone-check"
      data-phase={phase}
      className={cn("flex flex-col gap-3", className)}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
            phase === "tone"
              ? roleClasses("action").tile
              : roleClasses("neutral").tile,
            phase === "tone"
              ? roleClasses("action").glyph
              : roleClasses("neutral").glyph,
          )}
          aria-hidden
        >
          {phase === "tone" ? (
            <Volume2 className="h-4 w-4" aria-hidden />
          ) : (
            <Mic className="h-4 w-4" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="ui-text-row-label-emphasized">Microphone</p>
          <p className="ui-text-row-description">
            Three seconds of level, then a short tone. Nothing is recorded or
            sent.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void run()}
          disabled={busy}
          isLoading={phase === "probing"}
          data-testid="one-voice-microphone-check-run"
          className="min-h-11 shrink-0 px-4"
        >
          {label}
        </Button>
      </div>

      {phase === "metering" ? (
        <div
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          data-testid="one-voice-microphone-meter"
          className="relative h-2 w-full overflow-hidden rounded-full bg-[color:var(--app-neutral-fill)]"
        >
          <span
            className="one-voice-level-fill absolute inset-y-0 left-0 rounded-full bg-[color:var(--app-accent)]"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}

      {phase === "done" || phase === "failed" ? (
        <div
          role="status"
          data-testid="one-voice-microphone-report"
          className="rounded-[var(--app-card-radius-compact,16px)] border border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-compact)] p-3"
        >
          <p
            className={cn(
              "inline-flex items-center gap-1.5 text-[15px] font-semibold",
              phase === "failed"
                ? danger.glyph
                : report.heard
                  ? success.glyph
                  : warning.glyph,
            )}
          >
            {phase === "failed" ? null : report.heard ? (
              <Check className="h-4 w-4" aria-hidden />
            ) : null}
            {phase === "failed"
              ? (error?.message ?? "Voice could not start.")
              : report.heard
                ? "Microphone works"
                : "We didn't hear anything"}
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-[color:var(--app-secondary-label)]">
              Sample rate
            </dt>
            <dd
              className="text-[color:var(--app-label)]"
              data-testid="one-voice-microphone-sample-rate"
            >
              {formatSampleRate(report.sampleRate)}
            </dd>
            <dt className="text-[color:var(--app-secondary-label)]">
              Echo cancellation
            </dt>
            <dd
              className="text-[color:var(--app-label)]"
              data-testid="one-voice-microphone-echo"
            >
              {report.echoCancellation === null
                ? "Unknown"
                : report.echoCancellation
                  ? "On"
                  : "Off"}
            </dd>
            <dt className="text-[color:var(--app-secondary-label)]">
              Capture worklet
            </dt>
            <dd
              className="text-[color:var(--app-label)]"
              data-testid="one-voice-microphone-worklet"
            >
              {report.workletLoaded ? "Loaded" : "Not loaded"}
            </dd>
            {phase === "done" ? (
              <>
                <dt className="text-[color:var(--app-secondary-label)]">
                  Test tone
                </dt>
                <dd
                  className="text-[color:var(--app-label)]"
                  data-testid="one-voice-microphone-tone"
                >
                  {report.tonePlayed ? "Played" : "Could not play"}
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
