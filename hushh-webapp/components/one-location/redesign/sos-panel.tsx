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
import { Check, ChevronRight, Loader2, Phone } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type { OneLocationRecipient } from "@/lib/one-location/types";
import type {
  EmergencyInfo,
  EmergencyNumberLookupStatus,
} from "@/lib/one-location/emergency-numbers";
import { ONE_LOCATION_SHARE_NOTE_MAX_LENGTH } from "@/lib/one-location/message-limits";

const HOLD_DURATION_MS = 2_000;
export type SmsQuickMessage = "Come get me" | "I'm not safe";
/**
 * The two presets from the Save My Soul design. Picking one writes its text
 * into the single always-visible message field instead of holding a separate
 * "which preset is selected" state: to the sender a preset and a typed note
 * are the same thing, so there is only ever one message to reason about.
 */
const QUICK_MESSAGES: readonly SmsQuickMessage[] = [
  "I'm not safe",
  "Come get me",
];

/**
 * Circumference of the progress ring in viewBox units (2π × r, r = 168).
 * The SVG scales through its viewBox, so this one constant drives the sweep at
 * every breakpoint — the ring does not need a per-size copy of itself.
 */
const RING_CIRCUMFERENCE = 1055.6;

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
   * Stop a live SMS session: revokes the location grants created by the
   * alert AND clears the incident, so "SENT · Live now" resets. Kept separate
   * from `onClose` (which only closes the screen without stopping sharing).
   */
  onStopSos: () => void;
  /** True while the stop request is in flight. */
  stopBusy: boolean;
  onClose: () => void;
  onEditContacts: () => void;

  recipientLabel: (recipient: OneLocationRecipient) => string;
  isRecipientShareReady: (recipient: OneLocationRecipient) => boolean;
  emergency: EmergencyInfo | null;
  emergencyStatus: EmergencyNumberLookupStatus;
  onResolveEmergencyNumber: () => void;
};

export function SosPanel({
  recipients,
  active,
  busy,
  onTrigger,
  onStopSos,
  stopBusy,
  onEditContacts,
  isRecipientShareReady,
  emergency,
  emergencyStatus,
  onResolveEmergencyNumber,
}: SosPanelProps) {
  const [customMessage, setCustomMessage] = useState("");
  const [messageFocused, setMessageFocused] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);

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
  const [, setWindowsCopyStatus] =
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
  const customMessageLength = customMessage.length;
  const customMessageLimitExceeded =
    customMessageLength > ONE_LOCATION_SHARE_NOTE_MAX_LENGTH;
  // An empty field is valid. The payload of the alert is the location; the
  // message is an optional note on top of it, so "send with no message" must
  // stay reachable in the state someone is actually in when they need it.
  const selectedMessage = customMessage.trim() || null;
  const customMessageInvalid = customMessageLimitExceeded;
  const noReadyRecipients = readyRecipients.length === 0;
  const hardDisabled = busy || active || customMessageInvalid;
  const disabled = hardDisabled || noReadyRecipients;
  const shouldFallbackWindowsEmergencyCall =
    isWindowsDesktopEmCallUnsupported();
  const recipientCount = readyRecipients.length;
  const recipientCountLabel =
    recipientCount === 1 ? "1 contact" : `${recipientCount} contacts`;
  const alertedSummary = `${recipientCountLabel} alerted`;
  const showMessageCount =
    messageFocused ||
    customMessageLength > 0 ||
    customMessageLength >= ONE_LOCATION_SHARE_NOTE_MAX_LENGTH - 20 ||
    customMessageLimitExceeded;
  const messageDescribedBy = customMessageLimitExceeded
    ? "sos-short-message-error sos-short-message-count"
    : showMessageCount
      ? "sos-short-message-count"
      : undefined;

  // The alert ending is the only thing that releases the record and the lock.
  // Stopping is deliberately the single escape: an editable picker over a
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

  // Pointer capture (set on pointerdown, above) is what lets the hold survive
  // the cursor drifting off the circular hitbox — pointerup/pointercancel are
  // routed to this button regardless of where the pointer physically ends up.
  // Some Chrome builds still fire `pointerleave` on boundary crossing even
  // while capture is held, which cancelled a perfectly good hold the instant a
  // mouse wobbled off the circle for a frame. Only treat leave as a real
  // release when capture was never established (e.g. an unsupported pointer
  // type), so the ring cannot be reset by anything short of an actual
  // pointerup/pointercancel/blur.
  const handlePointerLeave = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    cancelHold();
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
      toast.success(`${emergency.number} copied. Call from your phone.`, {
        duration: 10_000,
      });
    } catch {
      setWindowsCopyStatus("error");
      toast.error(`Call ${emergency.number} from your phone.`, {
        duration: 10_000,
      });
    }
  }, [emergency]);

  useEffect(() => {
    setWindowsCopyStatus("idle");
  }, [emergency?.number]);

  const isHolding = progress > 0 && progress < 1 && !busy && !active;
  const progressDashOffset = RING_CIRCUMFERENCE * (1 - progress);
  const remainingSeconds = Math.max(
    0.1,
    (HOLD_DURATION_MS - progress * HOLD_DURATION_MS) / 1000,
  ).toFixed(1);
  // The alert's own status line carries every state the ring can be in, so the
  // ring itself never has to grow a second label.
  const statusLabel = busy
    ? "Sending..."
    : active
      ? "Alert active"
      : isHolding
        ? `${remainingSeconds}s`
        : "Hold 2 seconds";

  const quickPill =
    "press-scale flex h-11 flex-1 items-center justify-center rounded-xl border text-[15px] font-medium leading-5 transition-colors";

  const callControl =
    emergencyStatus === "resolved" && emergency ? (
      shouldFallbackWindowsEmergencyCall ? (
        <button
          type="button"
          onClick={handleWindowsEmergencyCopy}
          data-testid="sos-emergency-actions"
          aria-label={`Copy ${emergency.number} emergency services (${emergency.countryName})`}
          className="press-scale flex min-h-[50px] w-full items-center gap-3 rounded-[14px] bg-[color:var(--app-card-surface-default-solid)] px-4 text-left text-[17px] font-semibold leading-[22px] text-[color:var(--app-destructive)] transition-colors hover:bg-[color:var(--app-destructive)]/5"
        >
          <Phone className="h-4 w-4" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            Call {emergency.number} · {emergency.countryName}
          </span>
          <ChevronRight
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </button>
      ) : (
        <a
          href={`tel:${emergency.number}`}
          data-testid="sos-emergency-actions"
          aria-label={`Call ${emergency.number} emergency services (${emergency.countryName})`}
          className="press-scale flex min-h-[50px] w-full items-center gap-3 rounded-[14px] bg-[color:var(--app-card-surface-default-solid)] px-4 text-left text-[17px] font-semibold leading-[22px] text-[color:var(--app-destructive)] transition-colors hover:bg-[color:var(--app-destructive)]/5"
        >
          <Phone className="h-4 w-4" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            Call {emergency.number} · {emergency.countryName}
          </span>
          <ChevronRight
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </a>
      )
    ) : (
      <button
        type="button"
        onClick={onResolveEmergencyNumber}
        disabled={emergencyStatus === "resolving"}
        data-testid="sos-emergency-actions"
        aria-label={
          emergencyStatus === "unavailable"
            ? "Retry local emergency number"
            : emergencyStatus === "resolving"
              ? "Finding local emergency number"
              : "Find local emergency number"
        }
        className="press-scale flex min-h-[50px] w-full items-center gap-3 rounded-[14px] bg-[color:var(--app-card-surface-default-solid)] px-4 text-left text-[17px] font-semibold leading-[22px] text-[color:var(--app-destructive)] transition-colors hover:bg-[color:var(--app-destructive)]/5 disabled:cursor-wait disabled:opacity-70"
      >
        <Phone className="h-4 w-4" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
        {emergencyStatus === "resolving" ? (
          "Finding local number"
        ) : emergencyStatus === "unavailable" ? (
          "Retry local number"
        ) : (
          "Find local number"
        )}
        </span>
        {emergencyStatus === "resolving" ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
        ) : (
          <ChevronRight
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        )}
      </button>
    );

  return (
    <section
      data-testid="sms-safety-screen"
      className="mx-auto flex w-full max-w-[560px] flex-col px-4 pb-6 pt-8 sm:px-0"
    >
      <header className="space-y-2">
        <h1 className="text-[34px] font-bold leading-[41px] tracking-[-0.02em] text-foreground">
          Save My Soul
        </h1>
        {active ? (
          <p className="text-[15px] leading-5 text-muted-foreground">
            {alertedSummary}
          </p>
        ) : noReadyRecipients ? (
          <p className="text-[15px] leading-5 text-muted-foreground">
            No emergency contacts
          </p>
        ) : (
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 truncate text-[15px] leading-5 text-muted-foreground">
              {recipientCountLabel} · Live location
            </p>
            <button
              type="button"
              onClick={onEditContacts}
              aria-label="Edit emergency contacts"
              className="press-scale -my-3 flex h-11 min-w-11 items-center justify-center rounded-full px-3 text-[15px] font-semibold leading-5 text-[color:var(--app-accent)]"
            >
              Edit
            </button>
          </div>
        )}
      </header>

      {noReadyRecipients ? (
        <div className="mt-6 space-y-6">
          <button
            type="button"
            onClick={onEditContacts}
            className="press-scale flex h-[52px] w-full items-center justify-center rounded-[16px] bg-[color:var(--app-accent)] px-5 text-[17px] font-semibold leading-[22px] text-white"
          >
            Add emergency contacts
          </button>
          {callControl}
        </div>
      ) : active ? (
        <div className="mt-6 space-y-6">
          <div className="flex flex-col items-center rounded-[20px] bg-[color:var(--app-card-surface-default-solid)] px-6 py-7 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[color:var(--app-destructive)]/10 text-[color:var(--app-destructive)]">
              <Check className="h-7 w-7" aria-hidden />
            </span>
            <p
              data-testid="sos-status-label"
              className="mt-4 text-[17px] font-semibold leading-[22px] text-foreground"
            >
              Alert active
            </p>
            <p className="mt-1 text-[15px] leading-5 text-muted-foreground">
              {alertedSummary}
            </p>
            {sentMessage ? (
              <p
                data-testid="sos-sent-message"
                className="mt-4 max-w-full rounded-[14px] bg-[color:var(--sos-control-surface)] px-4 py-3 text-[15px] leading-5 text-foreground"
              >
                {sentMessage}
              </p>
            ) : null}
            <span data-testid="sos-sent-face" className="sr-only">
              SENT
            </span>
          </div>

          {callControl}

          <button
            type="button"
            onClick={() => setStopConfirmOpen(true)}
            disabled={stopBusy}
            aria-label="Stop Save My Soul alert"
            data-testid="sos-cancel-alert"
            className="press-scale flex h-[52px] w-full items-center justify-center gap-2 rounded-[16px] bg-[color:var(--sos-control-surface)] px-5 text-[17px] font-semibold leading-[22px] text-[color:var(--app-destructive)] transition-colors hover:bg-[color:var(--sos-control-surface-hover)] disabled:opacity-60"
          >
            {stopBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : null}
            {stopBusy ? "Stopping..." : "Stop alert"}
          </button>
        </div>
      ) : (
        <>
          <div className="mt-6 flex gap-2.5 max-[359px]:flex-col">
            {QUICK_MESSAGES.map((option) => {
              const selected = customMessage === option;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setCustomMessage((current) =>
                      current === option ? "" : option,
                    )
                  }
                  className={cn(
                    quickPill,
                    selected
                      ? "border-[color:var(--app-destructive)]/40 bg-[color:var(--app-destructive)]/8 font-semibold text-[color:var(--app-destructive)]"
                      : "border-transparent bg-[color:var(--sos-control-surface)] text-[color:var(--sos-control-text)] hover:bg-[color:var(--sos-control-surface-hover)] active:bg-[color:var(--sos-control-surface-active)]",
                  )}
                >
                  {option}
                </button>
              );
            })}
          </div>

          <div className="mt-3">
            <label htmlFor="sos-short-message" className="sr-only">
              Add a message
            </label>
            <div
              className={cn(
                "relative flex h-[52px] items-center rounded-[14px] border bg-[color:var(--sos-control-surface)]",
                customMessageLimitExceeded
                  ? "border-[color:var(--app-destructive)]"
                  : "border-transparent focus-within:border-ring",
              )}
            >
              <input
                id="sos-short-message"
                type="text"
                aria-describedby={messageDescribedBy}
                aria-invalid={customMessageLimitExceeded}
                value={customMessage}
                onChange={(event) => setCustomMessage(event.target.value)}
                onFocus={() => setMessageFocused(true)}
                onBlur={() => setMessageFocused(false)}
                placeholder="Add message..."
                className="h-full min-w-0 flex-1 rounded-[14px] bg-transparent px-4 pr-12 text-[16px] leading-[22px] text-foreground outline-none placeholder:text-[color:var(--sos-placeholder)]"
              />
              <ChevronRight
                className="pointer-events-none absolute right-4 h-4 w-4 text-muted-foreground"
                aria-hidden
              />
            </div>
            <div className="mt-1 flex min-h-5 items-baseline justify-between gap-3">
              {customMessageLimitExceeded ? (
                <p
                  id="sos-short-message-error"
                  role="alert"
                  className="text-[12px] text-[color:var(--app-destructive)]"
                >
                  Message is too long
                </p>
              ) : (
                <span />
              )}
              {showMessageCount ? (
                <div
                  id="sos-short-message-count"
                  className={cn(
                    "text-right text-[12px]",
                    customMessageLimitExceeded
                      ? "text-[color:var(--app-destructive)]"
                      : "text-[color:var(--sos-label)]",
                  )}
                >
                  {customMessageLength}/{ONE_LOCATION_SHARE_NOTE_MAX_LENGTH}
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-7 flex flex-col items-center">
            <div className="relative flex aspect-square w-[196px] items-center justify-center sm:w-[204px]">
              <svg
                viewBox="0 0 344 344"
                aria-hidden
                className="absolute inset-0 h-full w-full -rotate-90"
              >
                <circle
                  cx="172"
                  cy="172"
                  r="168"
                  fill="none"
                  stroke="var(--sos-ring-track)"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
                {progress > 0 ? (
                  <circle
                    cx="172"
                    cy="172"
                    r="168"
                    fill="none"
                    stroke="var(--app-destructive)"
                    strokeWidth="5"
                    strokeLinecap="round"
                    strokeDasharray={RING_CIRCUMFERENCE}
                    strokeDashoffset={progressDashOffset}
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
              </svg>

              <button
                type="button"
                disabled={disabled}
                aria-label={`Press and hold for two seconds to send Save My Soul SMS alert with your live location to ${recipientCountLabel}`}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
                onPointerLeave={handlePointerLeave}
                onKeyDown={handleKeyDown}
                onKeyUp={handleKeyUp}
                onContextMenu={(event) => event.preventDefault()}
                data-sos-core={busy ? "" : undefined}
                className={cn(
                  "relative z-10 flex h-[78%] w-[78%] touch-none select-none items-center justify-center rounded-full bg-[color:var(--app-destructive)] text-[color:var(--app-destructive-fg)] outline-none",
                  "transition-transform duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background",
                  progress > 0 && "scale-[0.96]",
                  disabled && "cursor-not-allowed opacity-65",
                )}
              >
                <span className="text-[42px] font-semibold tracking-[1px]">
                  SMS
                </span>
              </button>
            </div>

            <p
              data-testid="sos-status-label"
              className="mt-3 text-center text-[15px] font-medium leading-5 text-[color:var(--sos-label)]"
            >
              {statusLabel}
            </p>
          </div>

          <div className="mt-6">{callControl}</div>
        </>
      )}

      <AlertDialog open={stopConfirmOpen} onOpenChange={setStopConfirmOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Stop Save My Soul alert?</AlertDialogTitle>
            <AlertDialogDescription>
              Your emergency contacts will stop receiving your live location.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopBusy}>
              Keep active
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={stopBusy}
              onClick={(event) => {
                event.preventDefault();
                onStopSos();
                setStopConfirmOpen(false);
              }}
            >
              Stop alert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
