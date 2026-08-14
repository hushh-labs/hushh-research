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
import { Loader2, Phone, SendHorizontal } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { TaskFlowHeader } from "./primitives";
import { SUBCARD_SURFACE } from "./tokens";
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

export function isWindowsDesktopEmCallUnsupported(options?: {
  userAgent?: string;
  platform?: string;
}) {
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
  /**
   * Returning the handler's promise is load-bearing: the panel awaits it to
   * learn whether the trigger actually started work. `handleTriggerSos` bails
   * out early (no SMS contacts, blocked permission, an incident already live)
   * without ever entering its busy phase, and the panel needs to know so it can
   * release the fired latch instead of sitting on a dead progress ring.
   */
  onTrigger: (message?: string | null) => void | Promise<void>;
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

  /**
   * The message that actually went out, held for as long as the alert is live.
   *
   * Without it the panel showed a live alert and an editable picker, and the
   * two had no relationship: whatever was selected looked like what had been
   * sent, and changing the selection changed nothing that anyone had received.
   * `null` while nothing is live; `""` when an alert was sent with no message.
   */
  const [sentMessage, setSentMessage] = useState<string | null>(null);

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
  const shouldFallbackWindowsEmergencyCall =
    isWindowsDesktopEmCallUnsupported();
  // Radar pulse is active the moment the user starts pressing, and keeps
  // emanating continuously while the SMS is sending and after it goes live.
  const showPulse = active || busy || progress > 0;
  // Editing is closed from the moment the alert is sent until it is cancelled.
  const messageLocked = active || busy;

  // The alert ending is the only thing that releases the record and the lock.
  // Cancelling is deliberately the single escape: an editable picker over a
  // live alert invites someone to believe they have changed a message that has
  // already been delivered.
  useEffect(() => {
    if (!active && !busy) setSentMessage(null);
  }, [active, busy]);

  const clearHold = useCallback((resetProgress = true) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    timeoutRef.current = null;
    frameRef.current = null;
    holdStartedAtRef.current = 0;
    if (resetProgress && !firedRef.current) setProgress(0);
  }, []);

  /**
   * Single path into `onTrigger`, shared by the press-and-hold ring and the
   * send button in the message box.
   *
   * The `finally` is the fix for a panel that could latch permanently: when
   * `onTrigger` returned early it never set `busy`, so the reset effect below
   * (which only runs on a busy true -> false edge) never fired, `firedRef`
   * stayed true, and `progress` stayed at 1. The ring then showed a frozen
   * "0.0 s" with the radar pulse running forever and refused every later press.
   * If the trigger never entered its busy phase there is nothing to wait for,
   * so release the latch here.
   */
  const fireTrigger = useCallback(() => {
    if (firedRef.current || disabled) return;
    firedRef.current = true;
    clearHold(false);
    setProgress(1);
    // Captured before the await so the record is of what was sent, not of
    // whatever the picker happens to hold when the request settles.
    setSentMessage(selectedMessage ?? "");
    void Promise.resolve(onTrigger(selectedMessage)).finally(() => {
      if (observedBusyRef.current) return;
      firedRef.current = false;
      setProgress(0);
    });
  }, [clearHold, disabled, onTrigger, selectedMessage]);

  const completeHold = useCallback(() => {
    fireTrigger();
  }, [fireTrigger]);

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

  /**
   * Send button inside the message box. A typed message is already a deliberate
   * act, so this sends immediately rather than asking for a second two-second
   * hold. Enter deliberately still inserts a newline: an emergency alert must
   * not be one stray keystroke away.
   */
  const handleSendCustomMessage = useCallback(() => {
    if (hardDisabled) return;
    if (noReadyRecipients) {
      toast.error(
        "Please add at least one contact in your SMS emergency contact list.",
      );
      return;
    }
    fireTrigger();
  }, [fireTrigger, hardDisabled, noReadyRecipients]);

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

  // The "your browser cannot dial" explanation is a toast, not body copy.
  //
  // As a permanent paragraph under the button it wrapped to four lines on the
  // narrow half-width grid cell, pushing Cancel around and burying the number
  // it was trying to give you. It is only true at the moment you tap, so it is
  // said at that moment — and the toast carries the number, which is the part
  // that is actually actionable.
  const handleWindowsEmergencyCopy = useCallback(async () => {
    if (!emergency) return;
    try {
      await navigator.clipboard.writeText(emergency.number);
      setWindowsCopyStatus("copied");
      toast.success(`${emergency.number} copied`, {
        description: `This browser cannot open a dialer. Call ${emergency.number} from your phone now — ${emergency.countryName}.`,
        duration: 10_000,
      });
    } catch {
      setWindowsCopyStatus("error");
      toast.error("Could not copy the number", {
        description: `Dial ${emergency.number} from your phone now — ${emergency.countryName}.`,
        duration: 10_000,
      });
    }
  }, [emergency]);

  useEffect(() => {
    setWindowsCopyStatus("idle");
  }, [emergency?.number]);

  return (
    // SOS is a Location task flow, not a separate app. It renders INSIDE the
    // signed-in shell like every other `?action=…` flow (Settings, Check-In,
    // Shared with me), so the top bar keeps showing the single back control and
    // the "One › Location › SOS" breadcrumb. It used to escape the shell as a
    // pinned full-viewport black overlay, which is what removed the breadcrumb
    // and forced a second, in-content back button onto the screen.
    <section data-testid="sms-safety-screen">
      {/* Same header grammar as the Location Settings flow: the route name is
          the eyebrow, the screen name is the title. Back lives in the top bar
          only — never a second arrow in the content. */}
      <TaskFlowHeader
        eyebrow="Location"
        title="SOS"
        description="Hold to send your live location by SMS."
      />

      {/* The emergency action is one centered stack: the hold control, then the
          message and recovery controls beneath it. Keeping this single column
          prevents the SMS action from reading like a separate desktop panel. */}
      <div className="mt-6 flex flex-col items-center gap-4">
        <div className="flex items-center justify-center">
          <div className="relative flex h-[204px] w-[204px] items-center justify-center">
            <span className="absolute inset-0 rounded-full border border-border" />
            <span className="absolute inset-[24px] rounded-full border border-border" />

            {/* Radar / alarm rings that emanate continuously from the red core
                while the SMS is being held, sent, and after it goes live. */}
            {showPulse ? (
              <>
                <span
                  aria-hidden="true"
                  data-sos-pulse
                  className="absolute h-[128px] w-[128px] rounded-full bg-[color:var(--app-destructive)]/40 [animation:sosRadarPulse_2.2s_ease-out_infinite]"
                />
                <span
                  aria-hidden="true"
                  data-sos-pulse
                  className="absolute h-[128px] w-[128px] rounded-full bg-[color:var(--app-destructive)]/40 [animation:sosRadarPulse_2.2s_ease-out_infinite] [animation-delay:0.73s]"
                />
                <span
                  aria-hidden="true"
                  data-sos-pulse
                  className="absolute h-[128px] w-[128px] rounded-full bg-[color:var(--app-destructive)]/40 [animation:sosRadarPulse_2.2s_ease-out_infinite] [animation-delay:1.46s]"
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
              data-sos-core={active || busy ? "" : undefined}
              className={cn(
                "relative z-10 flex h-[128px] w-[128px] touch-none select-none flex-col items-center justify-center rounded-full bg-[color:var(--app-destructive)] text-white outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background",
                progress > 0 && progress < 1 && "scale-[1.035]",
                (active || busy) &&
                  "[animation:sosCorePulse_2.2s_ease-in-out_infinite]",
                disabled && "cursor-not-allowed",
              )}
              style={{
                boxShadow:
                  progress > 0
                    ? `0 0 0 ${Math.round(progress * 8)}px rgba(255,59,48,.18)`
                    : undefined,
              }}
            >
              <span className="text-[28px] font-bold leading-[34px] tracking-normal">
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

        {/* `sosRadarPulse` / `sosCorePulse` and their reduced-motion guard live
            in app/globals.css with the rest of the app's motion, never in a
            style island declared by this component. */}

        <div className="w-full max-w-[360px]">
          {/* While an SMS/SOS session is live, the primary action becomes
              stopping it. Cancelling here revokes the location grants created by
              the alert AND clears the incident, so "SENT · Live now" resets and
              the change is mirrored in Active shares (and vice-versa). */}
          {active ? (
            <button
              type="button"
              onClick={onStopSos}
              disabled={stopBusy}
              aria-label="Cancel the alert and stop sharing your location"
              data-testid="sos-cancel-alert"
              className="press-scale mb-4 flex h-12 w-full items-center justify-center gap-2 rounded-full border border-[color:var(--app-destructive)] bg-[color:var(--app-card-surface-default-solid)] text-[15px] font-semibold text-[color:var(--app-destructive)] disabled:opacity-60"
            >
              {stopBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {stopBusy ? "Cancelling…" : "Cancel the alert"}
            </button>
          ) : null}

          <p className="truncate px-2 text-center text-[13px] text-muted-foreground">
            {names ? `SMS goes to ${names}` : "No SMS contacts selected"} ·{" "}
            <button
              type="button"
              onClick={onEditContacts}
              className="font-semibold text-[color:var(--app-accent)]"
            >
              Edit
            </button>
          </p>

          {/* What actually went out. A live alert with an editable picker and
              no record of the sent text left people unsure which message their
              contacts had received -- and free to change a selection that
              could no longer affect it. */}
          {sentMessage !== null ? (
            <div
              role="status"
              data-testid="sos-sent-message"
              className={cn(
                SUBCARD_SURFACE,
                "mt-3 p-3 text-[13px] leading-relaxed text-foreground",
              )}
            >
              <p className="font-semibold">{busy ? "Sending" : "Sent"}</p>
              <p className="mt-1 text-muted-foreground">
                {sentMessage
                  ? `“${sentMessage}”`
                  : "Your location, with no message."}
              </p>
              <p className="mt-2 text-muted-foreground/70">
                Cancel to change it.
              </p>
            </div>
          ) : null}

          <div className="mt-3 grid grid-cols-2 gap-2">
            {(["Come get me", "I'm not safe"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={messageSelection === option}
                disabled={messageLocked}
                onClick={() =>
                  setMessageSelection((current) =>
                    current === option ? null : option,
                  )
                }
                className={cn(
                  "press-scale h-11 rounded-full border text-[15px] font-semibold leading-5",
                  messageSelection === option
                    ? "border-foreground bg-foreground text-background"
                    : "border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] text-foreground",
                  messageLocked && "cursor-not-allowed opacity-50",
                )}
              >
                {option}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={messageSelection === "custom"}
              disabled={messageLocked}
              onClick={() =>
                setMessageSelection((current) =>
                  current === "custom" ? null : "custom",
                )
              }
              className={cn(
                "press-scale col-span-2 h-11 rounded-full border text-[15px] font-semibold leading-5",
                messageSelection === "custom"
                  ? "border-foreground bg-foreground text-background"
                  : "border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] text-foreground",
                messageLocked && "cursor-not-allowed opacity-50",
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
              <div className="relative">
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
                  readOnly={messageLocked}
                  placeholder="Type a short message"
                  rows={2}
                  className={cn(
                    // pr-14 reserves the send button's column so typed text
                    // never runs underneath it.
                    "min-h-[72px] w-full resize-none rounded-2xl border bg-[color:var(--app-card-surface-compact)] py-3 pl-3.5 pr-14 text-[17px] leading-[22px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring",
                    customMessageLimitExceeded
                      ? "border-[color:var(--app-destructive)]"
                      : "border-border",
                    messageLocked && "cursor-not-allowed opacity-60",
                  )}
                />
                {/* Without this the only way to send a typed message was to go
                    back up and hold the ring for two seconds, with nothing in
                    the message box confirming the text had been taken. */}
                <button
                  type="button"
                  data-testid="sos-send-custom-message"
                  onClick={handleSendCustomMessage}
                  disabled={hardDisabled || !selectedMessage}
                  aria-label="Send this SMS alert"
                  className={cn(
                    "press-scale absolute bottom-2.5 right-2.5 flex h-10 w-10 items-center justify-center rounded-full transition-colors",
                    hardDisabled || !selectedMessage
                      ? "bg-muted text-muted-foreground/50"
                      : "bg-[color:var(--app-destructive)] text-white",
                  )}
                >
                  {busy ? (
                    <Loader2 className="h-[18px] w-[18px] animate-spin" />
                  ) : (
                    <SendHorizontal
                      className="h-[18px] w-[18px]"
                      strokeWidth={2}
                    />
                  )}
                </button>
              </div>
              <div
                id="sos-short-message-count"
                className={cn(
                  "mt-1 text-right text-[12px]",
                  customMessageLimitExceeded
                    ? "text-[color:var(--app-destructive)]"
                    : "text-muted-foreground",
                )}
              >
                {customMessageLength}/{ONE_LOCATION_SHARE_NOTE_MAX_LENGTH}
              </div>
              {customMessageLimitExceeded ? (
                <p
                  id="sos-short-message-error"
                  role="alert"
                  className="mt-0.5 text-right text-[12px] text-[color:var(--app-destructive)]"
                >
                  character limit exceed
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {emergencyStatus === "resolved" && emergency ? (
              shouldFallbackWindowsEmergencyCall ? (
                <button
                  type="button"
                  onClick={handleWindowsEmergencyCopy}
                  className="press-scale flex h-12 items-center justify-center gap-2 rounded-full bg-[color:var(--app-destructive)] px-3 text-white"
                  aria-label={`Copy ${emergency.number} emergency services (${emergency.countryName})`}
                >
                  <Phone className="h-4 w-4 fill-current" aria-hidden />
                  <span className="min-w-0 text-left leading-tight">
                    <span className="block text-[15px] font-semibold">
                      {windowsCopyStatus === "copied"
                        ? `Copied ${emergency.number}`
                        : `Copy ${emergency.number}`}
                    </span>
                    <span className="block truncate text-[12px] text-white/75">
                      {windowsCopyStatus === "copied"
                        ? "Dial it from your phone"
                        : emergency.countryName}
                    </span>
                  </span>
                </button>
              ) : (
                <a
                  href={`tel:${emergency.number}`}
                  aria-label={`Call ${emergency.number} emergency services (${emergency.countryName})`}
                  className="press-scale flex h-12 items-center justify-center gap-2 rounded-full bg-[color:var(--app-destructive)] px-3 text-white"
                >
                  <Phone className="h-4 w-4 fill-current" aria-hidden />
                  <span className="min-w-0 text-left leading-tight">
                    <span className="block text-[15px] font-semibold">
                      Call {emergency.number}
                    </span>
                    <span className="block truncate text-[12px] text-white/75">
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
                className="press-scale flex h-12 items-center justify-center gap-2 rounded-full bg-[color:var(--app-destructive)] px-3 text-white disabled:cursor-wait disabled:opacity-75"
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
                  <span className="block truncate text-[12px] text-white/75">
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
              className="press-scale h-12 rounded-full border border-border text-[15px] font-semibold text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
