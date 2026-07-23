"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { ArrowLeft, Phone } from "lucide-react";

import { cn } from "@/lib/utils";
import type { OneLocationRecipient } from "@/lib/one-location/types";

const HOLD_DURATION_MS = 2_000;
export type SmsQuickMessage = "Come get me" | "I'm not safe";

export type SosPanelProps = {
  recipients: OneLocationRecipient[];
  active: boolean;
  busy: boolean;
  onTrigger: (message?: SmsQuickMessage | null) => void;
  onClose: () => void;
  onEditContacts: () => void;
  recipientLabel: (recipient: OneLocationRecipient) => string;
  isRecipientShareReady: (recipient: OneLocationRecipient) => boolean;
};

function firstNameOf(label: string): string {
  return label.trim().split(/\s+/)[0] || label.trim();
}

function formatNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

export function SosPanel({
  recipients,
  active,
  busy,
  onTrigger,
  onClose,
  onEditContacts,
  recipientLabel,
  isRecipientShareReady,
}: SosPanelProps) {
  const [message, setMessage] = useState<SmsQuickMessage | null>(null);
  const [progress, setProgress] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);
  const holdStartedAtRef = useRef(0);
  const firedRef = useRef(false);
  const observedBusyRef = useRef(false);

  const readyRecipients = useMemo(
    () => recipients.filter(isRecipientShareReady),
    [isRecipientShareReady, recipients],
  );
  const names = useMemo(
    () =>
      formatNames(
        readyRecipients.map((recipient) =>
          firstNameOf(recipientLabel(recipient)),
        ),
      ),
    [readyRecipients, recipientLabel],
  );
  const disabled = busy || active || readyRecipients.length === 0;

  const clearHold = useCallback((resetProgress = true) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    timeoutRef.current = null;
    frameRef.current = null;
    holdStartedAtRef.current = 0;
    if (resetProgress && !firedRef.current) setProgress(0);
  }, []);

  const completeHold = useCallback(() => {
    if (firedRef.current || disabled) return;
    firedRef.current = true;
    clearHold(false);
    setProgress(1);
    onTrigger(message);
  }, [clearHold, disabled, message, onTrigger]);

  const updateProgress = useCallback(() => {
    if (!holdStartedAtRef.current || firedRef.current) return;
    const elapsed = performance.now() - holdStartedAtRef.current;
    setProgress(Math.min(elapsed / HOLD_DURATION_MS, 1));
    if (elapsed < HOLD_DURATION_MS) {
      frameRef.current = requestAnimationFrame(updateProgress);
    }
  }, []);

  const startHold = useCallback(() => {
    if (disabled || holdStartedAtRef.current || firedRef.current) return;
    holdStartedAtRef.current = performance.now();
    setProgress(0);
    frameRef.current = requestAnimationFrame(updateProgress);
    timeoutRef.current = setTimeout(completeHold, HOLD_DURATION_MS);
  }, [completeHold, disabled, updateProgress]);

  const cancelHold = useCallback(() => clearHold(true), [clearHold]);

  useEffect(() => {
    const onWindowBlur = () => cancelHold();
    const onVisibility = () => {
      if (document.hidden) cancelHold();
    };
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      clearHold();
    };
  }, [cancelHold, clearHold]);

  useEffect(() => {
    if (busy) observedBusyRef.current = true;
    if (!busy && observedBusyRef.current && !active) {
      observedBusyRef.current = false;
      firedRef.current = false;
      setProgress(0);
    }
  }, [active, busy]);

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button > 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    startHold();
  };

  const handlePointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    cancelHold();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
      event.preventDefault();
      startHold();
    }
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      cancelHold();
    }
  };

  return (
    <section
      className="fixed inset-0 z-[90] overflow-y-auto bg-black text-white"
      data-testid="sms-safety-screen"
    >
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[407px] flex-col px-6 pb-[max(21px,env(safe-area-inset-bottom))] pt-[max(52px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to Location"
          className="press-scale flex h-10 w-10 items-center justify-center rounded-full bg-[#202023] text-white"
        >
          <ArrowLeft className="h-5 w-5" strokeWidth={2} />
        </button>

        <header className="mt-1 px-3 text-center">
          <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.45px]">
            SMS · Save my soul
          </h1>
          <p className="mx-auto mt-2 max-w-[290px] text-[14px] leading-[1.45] text-white/70">
            Press and hold. Your SMS contacts get your live location in One —
            when connected.
          </p>
        </header>

        <div className="flex min-h-[310px] flex-1 items-center justify-center py-6">
          <div className="relative flex h-[252px] w-[252px] items-center justify-center">
            <span className="absolute inset-0 rounded-full border border-white/10" />
            <span className="absolute inset-[24px] rounded-full border border-white/15" />
            <button
              type="button"
              disabled={disabled}
              aria-label={
                active
                  ? "SMS sharing is active"
                  : "Press and hold for two seconds to send SMS"
              }
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
              onPointerLeave={cancelHold}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onContextMenu={(event) => event.preventDefault()}
              className={cn(
                "relative z-10 flex h-[152px] w-[152px] touch-none select-none flex-col items-center justify-center rounded-full bg-[#ff3b30] text-white outline-none transition-transform focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-4 focus-visible:ring-offset-black",
                progress > 0 && progress < 1 && "scale-[1.035]",
                disabled && "cursor-not-allowed opacity-45",
              )}
              style={{
                boxShadow:
                  progress > 0
                    ? `0 0 0 ${Math.round(progress * 8)}px rgba(255,59,48,.18)`
                    : undefined,
              }}
            >
              <span className="text-[31px] font-bold leading-none">
                {active ? "SENT" : "SMS"}
              </span>
              <span className="mt-1.5 text-[12px] text-white/85">
                {busy
                  ? "Sending…"
                  : active
                    ? "Live now"
                    : progress > 0
                      ? `${Math.max(0, 2 - progress * 2).toFixed(1)} s`
                      : "Hold 2 s"}
              </span>
            </button>
          </div>
        </div>

        <div className="mt-auto">
          <p className="truncate px-2 text-center text-[13px] text-white/70">
            {names ? `SMS goes to ${names}` : "No SMS contacts selected"}{" "}
            ·{" "}
            <button
              type="button"
              onClick={onEditContacts}
              className="font-semibold text-[#2997ff]"
            >
              Edit
            </button>
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2">
            {(["Come get me", "I'm not safe"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={message === option}
                onClick={() =>
                  setMessage((current) => (current === option ? null : option))
                }
                className={cn(
                  "press-scale h-10 rounded-full border text-[13px] font-semibold",
                  message === option
                    ? "border-white bg-white text-black"
                    : "border-white/5 bg-[#1c1c1e] text-white",
                )}
              >
                {option}
              </button>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <a
              href="tel:911"
              className="press-scale flex h-12 items-center justify-center gap-2 rounded-full bg-[#ff3b30] text-[15px] font-semibold text-white"
            >
              <Phone className="h-4 w-4 fill-current" aria-hidden />
              Call 911
            </a>
            <button
              type="button"
              onClick={onClose}
              className="press-scale h-12 rounded-full border border-white/55 text-[15px] font-semibold text-white"
            >
              Cancel
            </button>
          </div>

          {!names ? (
            <p className="mt-2 text-center text-[12px] text-white/55">
              Add a ready connection before sending an SMS.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
