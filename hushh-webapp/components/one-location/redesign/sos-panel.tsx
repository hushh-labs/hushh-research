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
import { ChevronLeft, Loader2, Phone } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import type { OneLocationRecipient } from "@/lib/one-location/types";
import type {
  EmergencyInfo,
  EmergencyNumberLookupStatus,
} from "@/lib/one-location/emergency-numbers";
import { ONE_LOCATION_SHARE_NOTE_MAX_LENGTH } from "@/lib/one-location/message-limits";

const HOLD_DURATION_MS = 2_000;
export type SmsQuickMessage = "Come get me" | "I'm not safe";
type SmsMessageSelection = SmsQuickMessage | "custom" | null;

type WindowsFallbackCopyStatus = "idle" | "copied" | "error";

export function isWindowsDesktopEmCallUnsupported(
  options?: {
    userAgent?: string;
    platform?: string;
  },
) {
  const userAgent = (options?.userAgent ?? navigator.userAgent).toLowerCase();
  const platform = (options?.platform ?? navigator.platform).toLowerCase();
  const isWindows =
    /windows|win32|win64|wow64|win16/.test(platform) ||
    /windows nt|win64|wow64|win32/.test(userAgent);
  const isMobileOrTablet =
    /mobile|mobi|iphone|ipad|ipod|android/.test(userAgent) ||
    /phone|tablet|touch/.test(userAgent);

  return isWindows && !isMobileOrTablet;
}

export type SosPanelProps = {
  recipients: OneLocationRecipient[];
  active: boolean;
  busy: boolean;
  onTrigger: (message?: string | null) => void;
  /**
   * Stop a live SMS/SOS session: revokes the location grants created by the
   * alert AND clears the incident, so "SENT · Live now" resets. Kept separate
   * from `onClose` (which only closes the screen without stopping sharing).
   */
  onStopSos: () => void;
  /** True while the stop request is in flight (shows a spinner on Cancel). */
  stopBusy: boolean;
  onClose: () => void;
  onEditContacts: () => void;

  recipientLabel: (recipient: OneLocationRecipient) => string;
  isRecipientShareReady: (recipient: OneLocationRecipient) => boolean;
  emergency: EmergencyInfo | null;
  emergencyStatus: EmergencyNumberLookupStatus;
  onResolveEmergencyNumber: () => void;
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
  onStopSos,
  stopBusy,
  onClose,
  onEditContacts,
  recipientLabel,
  isRecipientShareReady,
  emergency,
  emergencyStatus,
  onResolveEmergencyNumber,
}: SosPanelProps) {

  const [messageSelection, setMessageSelection] =
    useState<SmsMessageSelection>(null);
  const [customMessage, setCustomMessage] = useState("");

  const [progress, setProgress] = useState(0);
  const [windowsCopyStatus, setWindowsCopyStatus] =
    useState<WindowsFallbackCopyStatus>("idle");
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
  const customMessageLength = customMessage.length;
  const customMessageLimitExceeded =
    customMessageLength > ONE_LOCATION_SHARE_NOTE_MAX_LENGTH;
  const selectedMessage =
    messageSelection === "custom" ? customMessage.trim() : messageSelection;
  const customMessageInvalid =
    messageSelection === "custom" &&
    (!selectedMessage || customMessageLimitExceeded);
  // True when the owner has not added any share-ready SMS contact yet. In this
  // case we keep the button PRESSABLE (see `hardDisabled` below) so the hold
  // handler can surface an actionable toast instead of silently doing nothing.
  const noReadyRecipients = readyRecipients.length === 0;
  // Blockers that must keep the button truly inert (sending in progress, already
  // live, or an invalid custom message). Missing contacts is intentionally NOT
  // here so the press can explain what to do.
  const hardDisabled = busy || active || customMessageInvalid;
  // Full guard used by the hold-completion path so a hold can never actually
  // send an SMS while there are no ready recipients.
  const disabled = hardDisabled || noReadyRecipients;
  const shouldFallbackWindowsEmergencyCall = isWindowsDesktopEmCallUnsupported();
  // Radar pulse is active the moment the user starts pressing, and keeps
  // emanating continuously while the SMS is sending and after it goes live.
  const showPulse = active || busy || progress > 0;


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
    onTrigger(selectedMessage);
  }, [clearHold, disabled, onTrigger, selectedMessage]);

  const updateProgress = useCallback(function tickProgress() {
    if (!holdStartedAtRef.current || firedRef.current) return;
    const elapsed = performance.now() - holdStartedAtRef.current;
    setProgress(Math.min(elapsed / HOLD_DURATION_MS, 1));
    if (elapsed < HOLD_DURATION_MS) {
      frameRef.current = requestAnimationFrame(tickProgress);
    }
  }, []);

  const startHold = useCallback(() => {
    if (hardDisabled || holdStartedAtRef.current || firedRef.current) return;
    if (noReadyRecipients) {
      toast.error(
        "Please add at least one contact in your SMS emergency contact list.",
      );
      return;
    }
    holdStartedAtRef.current = performance.now();
    setProgress(0);
    frameRef.current = requestAnimationFrame(updateProgress);
    timeoutRef.current = setTimeout(completeHold, HOLD_DURATION_MS);
  }, [completeHold, hardDisabled, noReadyRecipients, updateProgress]);

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

  const handleWindowsEmergencyCopy = useCallback(async () => {
    if (!emergency) return;
    try {
      await navigator.clipboard.writeText(emergency.number);
      setWindowsCopyStatus("copied");
    } catch {
      setWindowsCopyStatus("error");
    }
  }, [emergency]);

  useEffect(() => {
    setWindowsCopyStatus("idle");
  }, [emergency?.number]);

  return (
    <section
      className="fixed inset-0 z-[540] h-[100dvh] min-h-[100dvh] overflow-y-auto overscroll-none bg-black text-white"
      data-ambient-chrome-ignore
      data-testid="sms-safety-screen"
    >
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[407px] flex-col px-6 pb-[max(21px,env(safe-area-inset-bottom))] pt-[max(52px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to Location"
          className="press-scale flex h-10 w-10 items-center justify-center rounded-full bg-[#202023] text-white"
        >
          <ChevronLeft className="h-6 w-6" strokeWidth={2} />
        </button>

        <header className="mt-1 px-3 text-center">
          <h1 className="whitespace-nowrap !text-[28px] !font-bold !leading-[1.15] !tracking-[-0.45px]">
            SMS · Save my Soul
          </h1>
          <p className="mx-auto mt-2 max-w-[290px] text-[14px] leading-[1.45] text-white/70">
            Press and hold. An SMS with your live location goes to your people —
            even with no internet.
          </p>
        </header>

        <div className="flex min-h-[310px] flex-1 items-center justify-center py-6">
          <div className="relative flex h-[252px] w-[252px] items-center justify-center">
            <span className="absolute inset-0 rounded-full border border-white/10" />
            <span className="absolute inset-[24px] rounded-full border border-white/15" />

            {/* Radar / alarm rings that emanate continuously from the red core
                while the SMS is being held, sent, and after it goes live. */}
            {showPulse ? (
              <>
                <span
                  aria-hidden="true"
                  data-sos-pulse
                  className="absolute h-[152px] w-[152px] rounded-full bg-[#ff3b30]/40 [animation:sosRadarPulse_2.2s_ease-out_infinite]"
                />
                <span
                  aria-hidden="true"
                  data-sos-pulse
                  className="absolute h-[152px] w-[152px] rounded-full bg-[#ff3b30]/40 [animation:sosRadarPulse_2.2s_ease-out_infinite] [animation-delay:0.73s]"
                />
                <span
                  aria-hidden="true"
                  data-sos-pulse
                  className="absolute h-[152px] w-[152px] rounded-full bg-[#ff3b30]/40 [animation:sosRadarPulse_2.2s_ease-out_infinite] [animation-delay:1.46s]"
                />
              </>
            ) : null}

            <button
              type="button"
              // Only HARD blockers (sending, already live, invalid message)
              // disable the control. When the sole blocker is "no SMS contacts
              // added", the button stays pressable so the hold handler can show
              // an actionable toast instead of the press doing nothing.
              disabled={hardDisabled}
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
                (active || busy) && "[animation:sosCorePulse_2.2s_ease-in-out_infinite]",
                disabled && "cursor-not-allowed",
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

        <style>{`
          @keyframes sosRadarPulse {
            0% { transform: scale(1); opacity: 0.55; }
            80% { opacity: 0; }
            100% { transform: scale(1.62); opacity: 0; }
          }
          @keyframes sosCorePulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.045); }
          }
          @media (prefers-reduced-motion: reduce) {
            [data-sos-pulse] { animation: none !important; opacity: 0 !important; }
          }
        `}</style>


        <div className="mt-auto">
          {/* While an SMS/SOS session is live, the primary action becomes
              stopping it. Cancelling here revokes the location grants created by
              the alert AND clears the incident, so "SENT · Live now" resets and
              the change is mirrored in Active shares (and vice-versa). */}
          {active ? (
            <button
              type="button"
              onClick={onStopSos}
              disabled={stopBusy}
              aria-label="Cancel SMS alert and stop sharing your location"
              data-testid="sos-cancel-alert"
              className="press-scale mb-3 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white text-[15px] font-semibold text-[#d70015] disabled:opacity-60"
            >
              {stopBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {stopBusy ? "Cancelling…" : "Cancel SMS Alert"}
            </button>
          ) : null}

          <p className="truncate px-2 text-center text-[13px] text-white/70">
            {names ? `SMS goes to ${names}` : "No SMS contacts selected"} ·{" "}
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
                aria-pressed={messageSelection === option}
                onClick={() =>
                  setMessageSelection((current) =>
                    current === option ? null : option,
                  )
                }
                className={cn(
                  "press-scale h-10 rounded-full border text-[13px] font-semibold",
                  messageSelection === option
                    ? "border-white bg-white text-black"
                    : "border-white/5 bg-[#1c1c1e] text-white",
                )}
              >
                {option}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={messageSelection === "custom"}
              onClick={() =>
                setMessageSelection((current) =>
                  current === "custom" ? null : "custom",
                )
              }
              className={cn(
                "press-scale col-span-2 h-10 rounded-full border text-[13px] font-semibold",
                messageSelection === "custom"
                  ? "border-white bg-white text-black"
                  : "border-white/5 bg-[#1c1c1e] text-white",
              )}
            >
              Short text message
            </button>
          </div>

          {messageSelection === "custom" ? (
            <div className="mt-3">
              <label htmlFor="sos-short-message" className="sr-only">
                Short text message
              </label>
              <textarea
                id="sos-short-message"
                aria-describedby={
                  customMessageLimitExceeded
                    ? "sos-short-message-count sos-short-message-error"
                    : "sos-short-message-count"
                }
                aria-invalid={customMessageLimitExceeded}
                value={customMessage}
                onChange={(event) => setCustomMessage(event.target.value)}
                placeholder="Type a short message"
                rows={2}
                className={cn(
                  "min-h-[72px] w-full resize-none rounded-2xl border bg-[#1c1c1e] px-3.5 py-3 text-[14px] leading-relaxed text-white outline-none placeholder:text-white/40 focus:border-white/55",
                  customMessageLimitExceeded
                    ? "border-[#ff453a]"
                    : "border-white/10",
                )}
              />
              <div
                id="sos-short-message-count"
                className={cn(
                  "mt-1 text-right text-[12px]",
                  customMessageLimitExceeded
                    ? "text-[#ff6961]"
                    : "text-white/55",
                )}
              >
                {customMessageLength}/{ONE_LOCATION_SHARE_NOTE_MAX_LENGTH}
              </div>
              {customMessageLimitExceeded ? (
                <p
                  id="sos-short-message-error"
                  role="alert"
                  className="mt-0.5 text-right text-[12px] text-[#ff6961]"
                >
                  character limit exceed
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {emergencyStatus === "resolved" && emergency ? (
              shouldFallbackWindowsEmergencyCall ? (
                <div className="flex min-h-12 flex-col justify-center">
                  <button
                    type="button"
                    onClick={handleWindowsEmergencyCopy}
                    className="press-scale flex h-12 items-center justify-center gap-2 rounded-full bg-[#ff3b30] px-3 text-white"
                    aria-label={`Copy ${emergency.number} emergency services (${emergency.countryName})`}
                  >
                    <Phone className="h-4 w-4 fill-current" aria-hidden />
                    <span className="min-w-0 text-left leading-tight">
                      <span className="block text-[15px] font-semibold">
                        Copy emergency number
                      </span>
                      <span className="block truncate text-[10px] text-white/75">
                        {emergency.countryName} · {emergency.number}
                      </span>
                    </span>
                  </button>
                  <span className="mt-1 block text-[11px] leading-tight text-white/75">
                    Windows browsers cannot open emergency dialers directly. Call {emergency.number}
                    from your phone now.
                  </span>
                  {windowsCopyStatus === "copied" ? (
                    <span className="mt-1 block text-[11px] leading-tight text-[#35d07f]">
                      Number copied to clipboard.
                    </span>
                  ) : null}
                  {windowsCopyStatus === "error" ? (
                    <span className="mt-1 block text-[11px] leading-tight text-[#ff9a75]">
                      Could not copy. Please open your phone dialer manually.
                    </span>
                  ) : null}
                </div>
              ) : (
                <a
                  href={`tel:${emergency.number}`}
                  aria-label={`Call ${emergency.number} emergency services (${emergency.countryName})`}
                  className="press-scale flex h-12 items-center justify-center gap-2 rounded-full bg-[#ff3b30] px-3 text-white"
                >
                  <Phone className="h-4 w-4 fill-current" aria-hidden />
                  <span className="min-w-0 text-left leading-tight">
                    <span className="block text-[15px] font-semibold">
                      Call {emergency.number}
                    </span>
                    <span className="block truncate text-[10px] text-white/75">
                      {emergency.countryName}
                    </span>
                  </span>
                </a>
              )
            ) : (
              <button
                type="button"
                onClick={onResolveEmergencyNumber}
                disabled={
                  emergencyStatus === "idle" || emergencyStatus === "resolving"
                }
                aria-label={
                  emergencyStatus === "unavailable"
                    ? "Retry local emergency number"
                    : "Finding local emergency number"
                }
                className="press-scale flex h-12 items-center justify-center gap-2 rounded-full bg-[#ff3b30] px-3 text-white disabled:cursor-wait disabled:opacity-75"
              >
                {emergencyStatus === "unavailable" ? (
                  <Phone className="h-4 w-4 fill-current" aria-hidden />
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                )}
                <span className="min-w-0 text-left leading-tight">
                  <span className="block text-[13px] font-semibold">
                    {emergencyStatus === "unavailable"
                      ? "Retry local number"
                      : "Finding local number"}
                  </span>
                  <span className="block truncate text-[10px] text-white/75">
                    {emergencyStatus === "unavailable"
                      ? "Location unavailable"
                      : "Using current location"}
                  </span>
                </span>
              </button>
            )}


            <button
              type="button"
              onClick={onClose}
              className="press-scale h-12 rounded-full border border-white/55 text-[15px] font-semibold text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
