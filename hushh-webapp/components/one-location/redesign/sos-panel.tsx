"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Shield, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OneLocationRecipient } from "@/lib/one-location/types";

export type SosPanelProps = {
  recipients: OneLocationRecipient[];
  active: boolean;
  busy: boolean;
  startedAtLabel: string | null;
  onTrigger: () => void;
  onStop: () => void;
  recipientLabel: (r: OneLocationRecipient) => string;
  isRecipientShareReady: (r: OneLocationRecipient) => boolean;
  countdownSeconds?: number;
};

/** First name only, for the "notify Ankit, Akshat and Kushal" sentence. */
function firstNameOf(label: string): string {
  const trimmed = label.trim();
  const first = trimmed.split(/\s+/)[0];
  return first || trimmed;
}

/** "Ankit", "Ankit and Akshat", "Ankit, Akshat and Kushal", "… and 2 others". */
function formatNames(names: string[]): string {
  if (names.length === 0) return "your circle";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const shown = names.slice(0, 3);
  if (names.length === 3) return `${shown[0]}, ${shown[1]} and ${shown[2]}`;
  return `${shown[0]}, ${shown[1]} and ${names.length - 2} others`;
}

/**
 * SOS card for the Safety screen (Apple Blue v2 design).
 *
 * Behaviour is unchanged from the original panel: the primary red button arms a
 * short, cancellable countdown before firing `onTrigger` (never fires by
 * accident); while active it shows the "alerted" state with an "I'm safe" stop.
 * Only the presentation is reskinned to the design — literal red values with
 * dark variants layered on.
 */
export function SosPanel({
  recipients,
  active,
  busy,
  startedAtLabel,
  onTrigger,
  onStop,
  recipientLabel,
  isRecipientShareReady,
  countdownSeconds = 5,
}: SosPanelProps) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firedRef = useRef(false);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => stopTimer, []);

  // Stable reference so the active-flip effect can list it without re-firing every render.
  const cancelCountdown = useCallback(() => {
    stopTimer();
    firedRef.current = false;
    setRemaining(null);
  }, []);

  const startCountdown = () => {
    if (busy || active) return;
    firedRef.current = false;
    setRemaining(countdownSeconds);
    stopTimer();
    timerRef.current = setInterval(() => {
      // Pure decrement only — side-effects (onTrigger) live in a useEffect below.
      setRemaining((prev) => (prev === null ? null : prev - 1));
    }, 1000);
  };

  // Fire onTrigger exactly once when the countdown reaches zero.
  // Keeping it outside the functional updater prevents double-firing under StrictMode.
  useEffect(() => {
    if (remaining === 0 && !firedRef.current) {
      firedRef.current = true;
      stopTimer();
      setRemaining(null);
      onTrigger();
    }
  }, [remaining, onTrigger]);

  // Cancel any running countdown when the SOS becomes active externally.
  useEffect(() => {
    if (active) cancelCountdown();
  }, [active, cancelCountdown]);

  const readyRecipients = recipients.filter(isRecipientShareReady);
  const readyCount = readyRecipients.length;
  const names = formatNames(
    (readyCount > 0 ? readyRecipients : recipients).map((r) =>
      firstNameOf(recipientLabel(r)),
    ),
  );

  // ACTIVE — the alert is live.
  if (active) {
    return (
      <section className="relative overflow-hidden rounded-[18px] bg-[#fbe9e6] p-[22px] shadow-[0_2px_10px_rgba(0,0,0,0.05)] dark:bg-[#3a1512]">
        <div
          className="pointer-events-none absolute right-6 top-1/2 flex h-[66px] w-[66px] -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-[0_4px_16px_rgba(148,32,26,0.2)] dark:bg-white/10"
          aria-hidden
        >
          <Shield className="h-7 w-7 text-[#e0342c]" strokeWidth={1.5} />
        </div>
        <div className="relative z-[1] max-w-[210px]">
          <div className="flex items-center gap-2">
            <span className="h-[11px] w-[11px] rounded-full bg-[#e0342c]" />
            <span className="text-[14px] font-bold tracking-[0.04em] text-[#d92c24] dark:text-[#ff6f66]">
              ALERT ACTIVE
            </span>
          </div>
          <h2 className="mt-3.5 max-w-[200px] text-[29px] font-bold leading-[1.15] tracking-[-0.4px] text-foreground">
            Your circle has been alerted
          </h2>
          <p className="mt-3 text-[15px] leading-[1.5] text-black/50 dark:text-white/55">
            Your trusted contacts have been notified and can see your live
            location.
          </p>
          <div className="mt-5 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#34c759]" />
            <span className="text-[16px] font-bold text-foreground">Live now</span>
          </div>
          {startedAtLabel ? (
            <p className="ml-[18px] mt-1 text-[14px] text-black/45 dark:text-white/45">
              Started {startedAtLabel}
            </p>
          ) : null}
          <Button
            variant="destructive"
            onClick={onStop}
            isLoading={busy}
            className="mt-5 h-12 w-full rounded-full text-[15px] font-semibold"
          >
            I&apos;m safe — Stop sharing
          </Button>
        </div>
      </section>
    );
  }

  // ARMED — countdown running, still cancellable.
  if (remaining !== null) {
    return (
      <section className="rounded-[18px] bg-white p-[22px] text-center shadow-[0_2px_10px_rgba(0,0,0,0.05)] dark:bg-white/[0.05]">
        <p className="text-[15px] font-semibold text-[#d92c24] dark:text-[#ff6f66]">
          Alerting {names} in
        </p>
        <p
          className="my-2 text-6xl font-bold text-[#e0342c]"
          aria-live="assertive"
        >
          {remaining}
        </p>
        <Button
          variant="outline"
          onClick={cancelCountdown}
          className="h-12 w-full rounded-full text-[15px] font-semibold"
        >
          <X className="mr-1.5 h-4 w-4" aria-hidden />
          Cancel
        </Button>
      </section>
    );
  }

  // CALM — SOS ready.
  return (
    <section className="rounded-[18px] bg-white p-[22px] shadow-[0_2px_10px_rgba(0,0,0,0.05)] dark:bg-white/[0.05]">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#34c759]" />
        <span className="text-[14px] font-bold tracking-[0.04em] text-[#28a745] dark:text-[#4ade80]">
          SOS READY
        </span>
      </div>
      <h2 className="mt-3 text-[26px] font-bold leading-[1.15] tracking-[-0.4px] text-foreground">
        You&apos;re covered
      </h2>
      <p className="mt-2.5 text-[15px] leading-[1.5] text-black/50 dark:text-white/55">
        Hold Alert to notify {names} with your live location. It never fires by
        accident.
      </p>
      <button
        type="button"
        onClick={startCountdown}
        disabled={busy || readyCount === 0}
        className={cn(
          "mt-[18px] flex w-full items-center justify-center gap-2 rounded-full bg-[#e0342c] py-[14px] text-[15px] font-semibold text-white transition-opacity",
          (busy || readyCount === 0) && "opacity-50",
        )}
      >
        <Shield className="h-4 w-4" strokeWidth={1.8} />
        Open Alert
      </button>
      {readyCount === 0 ? (
        <p className="mt-2.5 text-center text-[12px] text-black/45 dark:text-white/45">
          Add a trusted contact who&apos;s ready to receive your location.
        </p>
      ) : null}
    </section>
  );
}
