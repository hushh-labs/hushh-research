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
import { Check, Loader2, Phone } from "lucide-react";
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
/**
 * The two presets from the Save My Soul design. Picking one writes its text
 * into the single always-visible message field instead of holding a separate
 * "which preset is selected" state: to the sender a preset and a typed note
 * are the same thing, so there is only ever one message to reason about.
 */
const QUICK_MESSAGES: readonly SmsQuickMessage[] = [
  "Come get me",
  "I'm not safe",
];

/**
 * Circumference of the progress ring in viewBox units (2π × r, r = 168).
 * The SVG scales through its viewBox, so this one constant drives the sweep at
 * every breakpoint — the ring does not need a per-size copy of itself.
 */
const RING_CIRCUMFERENCE = 1055.6;
const RING_RADIUS = RING_CIRCUMFERENCE / (2 * Math.PI);
const RING_CENTER = 172;

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
  // Editing is closed from the moment the alert is sent until it is cancelled.
  const messageLocked = active || busy;
  const recipientCount = readyRecipients.length;
  const recipientCountLabel =
    recipientCount === 1 ? "1 contact" : `${recipientCount} contacts`;
  const recipientSummary = `Alerts ${recipientCountLabel}`;
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

  // Endpoint of each half-arc, computed directly from `progress` rather than
  // via stroke-dasharray/-dashoffset. The dash trick reliably anchors growth
  // at the path's start when combined with a `<circle>` rotated -90deg (the
  // standard recipe every tutorial uses), but that guarantee does not carry
  // over to an explicit two-point `<path>` arc — it rendered growing from the
  // BOTTOM (the arc's end point) instead of the top. Walking the angle by
  // hand removes that ambiguity: at progress 0 the endpoint IS the top point
  // (a zero-length arc, invisible), and at progress 1 it is exactly the
  // bottom point, with nothing in between left to a dash/gap tiling.
  const ringSweepAngle = progress * Math.PI;
  const ringEndDx = RING_RADIUS * Math.sin(ringSweepAngle);
  const ringEndY = RING_CENTER - RING_RADIUS * Math.cos(ringSweepAngle);
  const ringRightArcD = `M${RING_CENTER},${RING_CENTER - RING_RADIUS} A${RING_RADIUS},${RING_RADIUS} 0 0 1 ${RING_CENTER + ringEndDx},${ringEndY}`;
  const ringLeftArcD = `M${RING_CENTER},${RING_CENTER - RING_RADIUS} A${RING_RADIUS},${RING_RADIUS} 0 0 0 ${RING_CENTER - ringEndDx},${ringEndY}`;

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

  // The alert's own status line carries every state the ring can be in, so the
  // ring itself never has to grow a second label.
  const statusLabel = busy
    ? "Sending alert…"
    : active
      ? "Alert active"
      : progress > 0
        ? `Holding ${Math.max(1, Math.ceil(2 - progress * 2))} s`
        : noReadyRecipients
          ? "Add contacts to alert"
          : "Hold to alert contacts";

  const quickPill =
    "press-scale flex h-11 flex-1 items-center justify-center rounded-xl text-[15px] font-medium leading-5 transition-colors sm:h-12";

  const callControl =
    emergencyStatus === "resolved" && emergency ? (
      shouldFallbackWindowsEmergencyCall ? (
        <button
          type="button"
          onClick={handleWindowsEmergencyCopy}
          aria-label={`Copy ${emergency.number} emergency services (${emergency.countryName})`}
          className="press-scale ml-auto flex min-h-11 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-destructive)] px-4 text-[15px] font-semibold leading-5 text-[color:var(--app-destructive-fg)] transition-opacity hover:opacity-90"
        >
          {windowsCopyStatus === "copied" ? "Copied" : "Copy"}
        </button>
      ) : (
        <a
          href={`tel:${emergency.number}`}
          aria-label={`Call ${emergency.number} emergency services (${emergency.countryName})`}
          className="press-scale ml-auto flex min-h-11 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-destructive)] px-4 text-[15px] font-semibold leading-5 text-[color:var(--app-destructive-fg)] transition-opacity hover:opacity-90"
        >
          Call
        </a>
      )
    ) : (
      <button
        type="button"
        onClick={onResolveEmergencyNumber}
        disabled={emergencyStatus === "resolving"}
        aria-label={
          emergencyStatus === "unavailable"
            ? "Retry local emergency number"
            : emergencyStatus === "resolving"
              ? "Finding local emergency number"
              : "Find local emergency number"
        }
        className="press-scale ml-auto flex min-h-11 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-destructive)] px-4 text-[15px] font-semibold leading-5 text-[color:var(--app-destructive-fg)] transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-70"
      >
        {emergencyStatus === "resolving" ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : emergencyStatus === "unavailable" ? (
          "Retry"
        ) : (
          "Find"
        )}
      </button>
    );

  return (
    // SMS is a Location task flow, not a separate app. It renders INSIDE the
    // signed-in shell like every other `?action=…` flow (Settings, Check-In,
    // Shared with me), so the top bar keeps showing the single back control,
    // the "Location › SMS" breadcrumb and the profile avatar. It used
    // to escape the shell as a pinned full-viewport black overlay, which is
    // what removed all three and forced a second back button into the content.
    <section data-testid="sms-safety-screen">
      <TaskFlowHeader
        title="Save My Soul"
        description="Alerts your emergency contacts with your live location."
      />

      <div className="mx-auto mt-5 w-full max-w-[560px] space-y-3">
        <div
          data-testid="sos-emergency-actions"
          className="flex min-h-[64px] items-center gap-3 rounded-[20px] border border-[color:var(--app-destructive)]/18 bg-[color:var(--app-card-surface-default-solid)] px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.06)]"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[color:var(--app-destructive)]/10 text-[color:var(--app-destructive)]">
            <Phone className="h-5 w-5 fill-current" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[17px] font-semibold leading-[22px] text-[color:var(--app-destructive)]">
              Call local emergency services
            </span>
            <span className="block truncate text-[13px] leading-[18px] text-muted-foreground">
              {emergencyStatus === "resolved" && emergency
                ? shouldFallbackWindowsEmergencyCall
                  ? `${emergency.number} · ${emergency.countryName}`
                  : `${emergency.number} · ${emergency.countryName}`
                : emergencyStatus === "resolving"
                  ? "Finding local number"
                  : emergencyStatus === "unavailable"
                    ? "Location unavailable"
                    : "Use your location"}
            </span>
          </span>
          {callControl}
        </div>

        <div className="flex min-h-[64px] items-center gap-3 rounded-[20px] bg-[color:var(--app-card-surface-default-solid)] px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[color:var(--app-destructive)]/10 text-[color:var(--app-destructive)]">
            <Check className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[17px] font-semibold leading-[22px] text-foreground">
              Emergency contacts
            </span>
            <span className="block text-[13px] leading-[18px] text-muted-foreground">
              {active ? `${recipientCountLabel} alerted` : `${recipientCountLabel} selected`}
            </span>
          </span>
          {!active ? (
            <button
              type="button"
              onClick={onEditContacts}
              aria-label="Edit emergency contacts"
              className="press-scale min-h-11 shrink-0 rounded-full px-3 text-[15px] font-semibold leading-5 text-[color:var(--app-accent)]"
            >
              {noReadyRecipients ? "Add" : "Edit"}
            </button>
          ) : null}
        </div>

        {noReadyRecipients ? (
          <div className="rounded-[18px] bg-[color:var(--app-card-surface-default-solid)] px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
            <p className="text-[17px] font-semibold leading-[22px] text-foreground">
              No emergency contacts
            </p>
            <p className="mt-0.5 text-[15px] leading-5 text-muted-foreground">
              Add at least one contact to send an alert.
            </p>
          </div>
        ) : null}
      </div>

      {/* One centered column at every width. The ring, its label and the
          message controls scale together; nothing splits into a desktop grid. */}
      <div className="mt-6 flex flex-col items-center sm:mt-7">
        <div className="relative flex aspect-square w-[216px] items-center justify-center sm:w-[232px] lg:w-[264px]">
          {progress > 0 ? (
            <span
              aria-hidden
              data-sos-pulse
              className="absolute inset-1 rounded-full bg-[color:var(--app-destructive)]/8"
            />
          ) : null}

          <svg
            viewBox="0 0 344 344"
            aria-hidden
            className="absolute inset-0 h-full w-full"
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
            {/* Two half-arcs, both starting at the top and racing down to meet
                at the bottom, so the hold reads as closing in from both sides
                rather than one hand sweeping clockwise. Both endpoints derive
                from the same `progress`, so they always land together. */}
            <path
              d={ringRightArcD}
              fill="none"
              stroke="var(--app-destructive)"
              strokeWidth="3"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={ringLeftArcD}
              fill="none"
              stroke="var(--app-destructive)"
              strokeWidth="3"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {active ? (
            // Sent. The core stops being a control and becomes a receipt.
            <div
              data-testid="sos-sent-face"
              className="relative flex h-[81%] w-[81%] items-center justify-center rounded-full bg-[color:var(--sos-live-face)] shadow-[inset_0_0_0_1px_var(--sos-live-face-ring)]"
            >
              <Check
                className="h-[26%] w-[26%] text-[color:var(--app-destructive)]"
                strokeWidth={2}
                aria-hidden
              />
              <span className="sr-only">SENT</span>
            </div>
          ) : (
            <button
              type="button"
              // Only HARD blockers (sending, already live, an over-length
              // message) disable the control. Missing contacts disables it too,
              // with the inline blocker explaining the next action.
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
                "relative z-10 flex h-[81%] w-[81%] touch-none select-none items-center justify-center rounded-full text-[color:var(--app-destructive-fg)] outline-none",
                "transition-[transform,box-shadow] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background",
                progress > 0 && "scale-[0.96]",
                busy && "[animation:sosCorePulse_2.2s_ease-in-out_infinite]",
                disabled && "cursor-not-allowed",
              )}
              style={{
                backgroundImage:
                  "linear-gradient(180deg, var(--sos-core-from) 0%, var(--sos-core-to) 100%)",
                boxShadow:
                  progress > 0
                    ? "0 16px 42px rgb(var(--sos-glow-rgb) / 0.24), inset 0 1px 0 rgba(255,255,255,0.24)"
                    : "0 10px 28px rgb(var(--sos-glow-rgb) / 0.16), inset 0 1px 0 rgba(255,255,255,0.24)",
              }}
            >
              {/* "SMS", the name this feature carries everywhere else in the
                  product — the Location menu tile is "SMS / Save My Soul", and
                  the outgoing message is an SMS. Only the visible glyph
                  changes: every identifier (data-testid, event name, scope
                  handle, backend enum) still says sos, because those are
                  contracts, not copy. */}
              <span className="text-[42px] font-semibold tracking-[1px] sm:text-[46px]">
                SMS
              </span>
            </button>
          )}
        </div>

        <p
          data-testid="sos-status-label"
          className="mt-4 text-center text-[15px] font-medium leading-5 text-[color:var(--sos-label)]"
        >
          {statusLabel}
        </p>

        <p className="mt-1 max-w-full truncate px-2 text-center text-[13px] leading-[18px] text-muted-foreground">
          {noReadyRecipients ? "No emergency contacts" : recipientSummary}
        </p>

        <div className="mt-6 flex w-full max-w-[560px] flex-col gap-3">
          {/* What actually went out. A live alert with an editable field and no
              record of the sent text left people unsure which message their
              contacts had received — and free to change a selection that could
              no longer affect it. */}
          {sentMessage !== null ? (
            <div
              role="status"
              data-testid="sos-sent-message"
              className={cn(
                SUBCARD_SURFACE,
                "p-3 text-[13px] leading-relaxed text-foreground",
              )}
            >
              <p className="font-semibold">{busy ? "Sending alert" : "Alert active"}</p>
              <p className="mt-1 text-muted-foreground">
                Live location shared with {recipientCountLabel}.
              </p>
              <p className="mt-1 text-muted-foreground">
                {sentMessage
                  ? `“${sentMessage}”`
                  : "No message added."}
              </p>
            </div>
          ) : null}

          <div className="flex gap-2.5 lg:gap-3">
            {QUICK_MESSAGES.map((option) => {
              const selected = customMessage === option;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={selected}
                  disabled={messageLocked}
                  onClick={() =>
                    setCustomMessage((current) =>
                      current === option ? "" : option,
                    )
                  }
                  className={cn(
                    quickPill,
                    // Picking a preset is SELECTION, not danger. It stays in
                    // the screen's red family — this is the emergency surface
                    // — but as the quiet wash, so the only solid emergency red
                    // on the screen remains the control that actually sends.
                    //
                    // The wash carries the state; the label keeps the same
                    // high-contrast control text its unselected siblings use.
                    // Red-on-red-wash falls to ~2.8:1 at this 16px size, on
                    // the one screen where a message gets picked under stress.
                    // `aria-pressed` and the weight change carry the state
                    // alongside the colour either way.
                    selected
                      ? "bg-[color:var(--app-destructive-surface)] font-semibold text-[color:var(--sos-control-text)]"
                      : "bg-[color:var(--sos-control-surface)] text-[color:var(--sos-control-text)] hover:bg-[color:var(--sos-control-surface-hover)] active:bg-[color:var(--sos-control-surface-active)]",
                    messageLocked && "cursor-not-allowed opacity-50",
                  )}
                >
                  {option}
                </button>
              );
            })}
          </div>

          <div className="relative">
            <label htmlFor="sos-short-message" className="sr-only">
              Add a message
            </label>
            <input
              id="sos-short-message"
              type="text"
              aria-describedby={messageDescribedBy}
              aria-invalid={customMessageLimitExceeded}
              value={customMessage}
              onChange={(event) => setCustomMessage(event.target.value)}
              onFocus={() => setMessageFocused(true)}
              onBlur={() => setMessageFocused(false)}
              readOnly={messageLocked}
              placeholder="Add a message"
              className={cn(
                "h-12 w-full rounded-xl border bg-[color:var(--sos-control-surface)] px-4 text-[16px] leading-[22px] text-foreground outline-none placeholder:text-[color:var(--sos-placeholder)] sm:h-[52px]",
                customMessageLimitExceeded
                  ? "border-[color:var(--app-destructive)]"
                  : "border-transparent focus:border-ring",
                messageLocked && "cursor-not-allowed opacity-60",
              )}
            />
          </div>

          <div className="flex items-baseline justify-between gap-3">
            {customMessageLimitExceeded ? (
              <p
                id="sos-short-message-error"
                role="alert"
                className="text-[12px] text-[color:var(--app-destructive)]"
              >
                {/* Same defect the hub copy had: lowercase, verbless, and
                    read aloud by screen readers via role="alert". This one is
                    on the emergency surface, where a message that does not
                    parse is worst. */}
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

          {active ? (
            <button
              type="button"
              onClick={() => setStopConfirmOpen(true)}
              disabled={stopBusy}
              aria-label="Stop Save My Soul alert"
              data-testid="sos-cancel-alert"
              className="press-scale flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-[color:var(--sos-control-surface)] px-5 text-[17px] font-semibold leading-[22px] text-[color:var(--app-destructive)] transition-colors hover:bg-[color:var(--sos-control-surface-hover)] disabled:opacity-60"
            >
              {stopBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {stopBusy ? "Stopping…" : "Stop alert"}
            </button>
          ) : null}
        </div>
      </div>
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
