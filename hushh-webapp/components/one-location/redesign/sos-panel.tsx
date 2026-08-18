"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import { Check, Loader2, Phone, Plus, SendHorizontal } from "lucide-react";
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
/**
 * The two presets from the Save my Soul design. Picking one writes its text
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

/**
 * The custom-message send button is a plain 40px circle, not the big ring's
 * 232-344px stage, so it doesn't need the two-arc trig workaround above (that
 * exists only because a `<path>` arc mis-anchors with stroke-dasharray -- a
 * single full-circle sweep on a rotated `<circle>` is the case dasharray
 * anchors correctly, so it's the simpler, standard technique here.
 */
const SEND_RING_RADIUS = 17;
const SEND_RING_CIRCUMFERENCE = 2 * Math.PI * SEND_RING_RADIUS;

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

type UseHoldToConfirmOptions = {
  durationMs: number;
  /** Hard block on starting a hold at all -- mirrors the button's own `disabled`. */
  disabled: boolean;
  /**
   * Shared across every hold control on the panel, not owned per-instance:
   * only one send can ever be in flight, so every control needs to see the
   * same "already armed" flag or two controls could both fire.
   */
  firedRef: MutableRefObject<boolean>;
  /** Short vibration tick every ~200ms of hold. Off by default so the
   * existing ring keeps its exact current behaviour when it adopts this hook. */
  haptics?: boolean;
  /** Runs on press before the timer starts; return false to block starting
   * (after showing its own feedback, e.g. a toast) without consuming a hold. */
  onGuardedStart?: () => boolean;
  onComplete: () => void;
};

/**
 * Press-and-hold state machine used by both the big SOS ring and the
 * custom-message send button. Extracted from the ring's original
 * implementation without changing its algorithm -- same RAF+setTimeout dual
 * drive, same pointer-capture-aware release handling -- so the ring's
 * existing tested behaviour carries over untouched.
 */
function useHoldToConfirm({
  durationMs,
  disabled,
  firedRef,
  haptics = false,
  onGuardedStart,
  onComplete,
}: UseHoldToConfirmOptions) {
  const [progress, setProgress] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);
  const holdStartedAtRef = useRef(0);
  const hapticBucketRef = useRef(0);

  const clearOwnTimers = useCallback(
    (resetProgress: boolean) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      timeoutRef.current = null;
      frameRef.current = null;
      holdStartedAtRef.current = 0;
      if (resetProgress && !firedRef.current) setProgress(0);
    },
    [firedRef],
  );

  const tick = useCallback(
    function tickProgress() {
      if (!holdStartedAtRef.current || firedRef.current) return;
      const elapsed = performance.now() - holdStartedAtRef.current;
      setProgress(Math.min(elapsed / durationMs, 1));
      if (haptics) {
        const bucket = Math.floor(elapsed / 200);
        if (bucket > hapticBucketRef.current) {
          hapticBucketRef.current = bucket;
          if (typeof navigator !== "undefined" && navigator.vibrate) {
            navigator.vibrate(15);
          }
        }
      }
      if (elapsed < durationMs) {
        frameRef.current = requestAnimationFrame(tickProgress);
      }
    },
    [durationMs, firedRef, haptics],
  );

  // The timeout, not the RAF loop, is authoritative for completion -- RAF
  // only drives the visual, so a throttled/backgrounded tab still fires.
  const complete = useCallback(() => {
    clearOwnTimers(false);
    setProgress(1);
    onComplete();
  }, [clearOwnTimers, onComplete]);

  const start = useCallback(() => {
    if (disabled || holdStartedAtRef.current || firedRef.current) return;
    if (onGuardedStart && !onGuardedStart()) return;
    hapticBucketRef.current = 0;
    holdStartedAtRef.current = performance.now();
    setProgress(0);
    frameRef.current = requestAnimationFrame(tick);
    timeoutRef.current = setTimeout(complete, durationMs);
  }, [complete, disabled, firedRef, onGuardedStart, tick, durationMs]);

  const cancel = useCallback(() => clearOwnTimers(true), [clearOwnTimers]);

  // Unconditional reset, called once the send this control may or may not
  // have fired has resolved. A no-op for whichever instance never held.
  const reset = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    timeoutRef.current = null;
    frameRef.current = null;
    holdStartedAtRef.current = 0;
    setProgress(0);
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button > 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      start();
    },
    [start],
  );

  // See the ring's original comment (kept in spirit): pointer capture is what
  // lets a hold survive the cursor drifting off the hitbox, and some Chrome
  // builds still fire `pointerleave` on boundary crossing even while capture
  // is held -- only treat leave as a real release when capture was never
  // established.
  const onPointerLeave = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
      cancel();
    },
    [cancel],
  );

  const onPointerEnd = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      cancel();
    },
    [cancel],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if ((event.key === " " || event.key === "Enter") && !event.repeat) {
        event.preventDefault();
        start();
      }
    },
    [start],
  );

  const onKeyUp = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        cancel();
      }
    },
    [cancel],
  );

  return {
    progress,
    cancel,
    reset,
    pressHandlers: {
      onPointerDown,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onPointerLeave,
      onKeyDown,
      onKeyUp,
    },
  };
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

  const [windowsCopyStatus, setWindowsCopyStatus] =
    useState<WindowsFallbackCopyStatus>("idle");
  const firedRef = useRef(false);
  const observedBusyRef = useRef(false);
  const resetHoldsRef = useRef<() => void>(() => {});

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
  // An empty field is valid. The payload of the alert is the location; the
  // message is an optional note on top of it, so "send with no message" must
  // stay reachable in the state someone is actually in when they need it.
  const selectedMessage = customMessage.trim() || null;
  const customMessageInvalid = customMessageLimitExceeded;
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
  // Editing is closed from the moment the alert is sent until it is cancelled.
  const messageLocked = active || busy;

  /**
   * Single path into `onTrigger`, shared by every hold control on the panel.
   *
   * The `finally` is the fix for a panel that could latch permanently: when
   * `onTrigger` returned early it never set `busy`, so the reset effect below
   * (which only runs on a busy true -> false edge) never fired and `firedRef`
   * stayed true forever, refusing every later press. If the trigger never
   * entered its busy phase there is nothing to wait for, so release the latch
   * here. `resetHoldsRef` is populated below, once the hold hooks exist --
   * `fireTrigger` has to come first so it can be handed to them as their
   * shared `onComplete`.
   */
  const fireTrigger = useCallback(() => {
    if (firedRef.current || disabled) return;
    firedRef.current = true;
    // Captured before the await so the record is of what was sent, not of
    // whatever the picker happens to hold when the request settles.
    setSentMessage(selectedMessage ?? "");
    void Promise.resolve(onTrigger(selectedMessage)).finally(() => {
      if (observedBusyRef.current) return;
      firedRef.current = false;
      resetHoldsRef.current();
    });
  }, [disabled, onTrigger, selectedMessage]);

  const guardReadyRecipients = useCallback(() => {
    if (noReadyRecipients) {
      toast.error(
        "Please add at least one contact in your SMS emergency contact list.",
      );
      return false;
    }
    return true;
  }, [noReadyRecipients]);

  const ringHold = useHoldToConfirm({
    durationMs: HOLD_DURATION_MS,
    disabled: hardDisabled,
    firedRef,
    onGuardedStart: guardReadyRecipients,
    onComplete: fireTrigger,
  });

  /**
   * Send button inside the message box. It used to fire on a single tap --
   * a typed message being "already a deliberate act" -- but that made it the
   * one control on this screen where a single accidental tap dispatched a
   * real emergency broadcast, so it now runs the same hold gate as the ring.
   * Enter deliberately still inserts a newline in the field above rather than
   * arming this control: an emergency alert must not be one stray keystroke
   * away.
   */
  const sendHold = useHoldToConfirm({
    durationMs: HOLD_DURATION_MS,
    disabled: hardDisabled || !selectedMessage,
    firedRef,
    haptics: true,
    onGuardedStart: guardReadyRecipients,
    onComplete: fireTrigger,
  });

  // Assigning a ref during render is unsafe in general, so this is done in an
  // effect instead -- it only needs to be current by the time `fireTrigger`'s
  // `.finally()` or the busy-observed-reset effect below actually calls it,
  // both of which only ever run after a commit has already happened.
  useEffect(() => {
    resetHoldsRef.current = () => {
      ringHold.reset();
      sendHold.reset();
    };
  });

  // Radar pulse is active the moment the user starts pressing the ring, and
  // keeps emanating continuously while the SMS is sending and after it goes
  // live. Not tied to `sendHold` -- that control has its own local progress
  // ring and countdown label instead (see the message box below).
  const showPulse = active || busy || ringHold.progress > 0;

  // Endpoint of each half-arc, computed directly from `progress` rather than
  // via stroke-dasharray/-dashoffset. The dash trick reliably anchors growth
  // at the path's start when combined with a `<circle>` rotated -90deg (the
  // standard recipe every tutorial uses), but that guarantee does not carry
  // over to an explicit two-point `<path>` arc — it rendered growing from the
  // BOTTOM (the arc's end point) instead of the top. Walking the angle by
  // hand removes that ambiguity: at progress 0 the endpoint IS the top point
  // (a zero-length arc, invisible), and at progress 1 it is exactly the
  // bottom point, with nothing in between left to a dash/gap tiling.
  const ringSweepAngle = ringHold.progress * Math.PI;
  const ringEndDx = RING_RADIUS * Math.sin(ringSweepAngle);
  const ringEndY = RING_CENTER - RING_RADIUS * Math.cos(ringSweepAngle);
  const ringRightArcD = `M${RING_CENTER},${RING_CENTER - RING_RADIUS} A${RING_RADIUS},${RING_RADIUS} 0 0 1 ${RING_CENTER + ringEndDx},${ringEndY}`;
  const ringLeftArcD = `M${RING_CENTER},${RING_CENTER - RING_RADIUS} A${RING_RADIUS},${RING_RADIUS} 0 0 0 ${RING_CENTER - ringEndDx},${ringEndY}`;

  // The alert ending is the only thing that releases the record and the lock.
  // Cancelling is deliberately the single escape: an editable picker over a
  // live alert invites someone to believe they have changed a message that has
  // already been delivered.
  useEffect(() => {
    if (!active && !busy) setSentMessage(null);
  }, [active, busy]);

  useEffect(() => {
    const onWindowBlur = () => {
      ringHold.cancel();
      sendHold.cancel();
    };
    const onVisibility = () => {
      if (document.hidden) {
        ringHold.cancel();
        sendHold.cancel();
      }
    };
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      ringHold.cancel();
      sendHold.cancel();
    };
    // `cancel` is stable for the life of the component (see `useHoldToConfirm`
    // -- it only depends on the never-changing `firedRef`), so depending on
    // the two functions directly is intentional; depending on `ringHold`/
    // `sendHold` themselves would re-run this every render, since the hook
    // returns a fresh object each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringHold.cancel, sendHold.cancel]);

  useEffect(() => {
    if (busy) observedBusyRef.current = true;
    if (!busy && observedBusyRef.current && !active) {
      observedBusyRef.current = false;
      firedRef.current = false;
      resetHoldsRef.current();
    }
  }, [active, busy]);

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

  // The alert's own status line, shown where the design puts "Hold to send
  // location". It carries every state the ring can be in, so the ring itself
  // never has to grow a second label.
  const statusLabel = busy
    ? "Sending…"
    : active
      ? "Live location"
      : ringHold.progress > 0
        ? `${Math.max(0, 2 - ringHold.progress * 2).toFixed(1)} s`
        : "Hold to send location";

  const quickPill =
    "press-scale flex h-[52px] flex-1 items-center justify-center rounded-xl text-[16px] tracking-[-0.3px] transition-colors lg:h-14 lg:text-[17px] lg:tracking-[-0.37px]";

  return (
    // SOS is a Location task flow, not a separate app. It renders INSIDE the
    // signed-in shell like every other `?action=…` flow (Settings, Check-In,
    // Shared with me), so the top bar keeps showing the single back control,
    // the "Location › Save my Soul" breadcrumb and the profile avatar. It used
    // to escape the shell as a pinned full-viewport black overlay, which is
    // what removed all three and forced a second back button into the content.
    <section data-testid="sms-safety-screen">
      {/* Same header grammar as every other Location screen: the crumb text and
          the heading are the same words. Back lives in the top bar only. */}
      <TaskFlowHeader
        title="Save my Soul"
        // Two facts, and only the two the screen cannot show: who it reaches,
        // and that it sends where you are. "Hold to…" was the third statement
        // of an instruction the button itself carries and the line under it
        // repeats verbatim.
        //
        // Still the literal truth, which matters more here than anywhere else
        // in the product: this creates a location grant and fires one push, so
        // it needs the network and it is not an offline text message. Someone
        // may hold this instead of calling for help.
        description="Alerts your emergency contacts with your live location."
      />

      {/* The design's top-right actions. The screen's own title moved into the
          header above, so only the two controls remain here. Width-matched
          to the message column below (max-w-[520px], centered) so "Cancel"
          doesn't right-align to the section edge while the input right-aligns
          to a narrower centered column beneath it (#5431). */}
      <div className="mx-auto mt-4 flex w-full max-w-[520px] flex-wrap items-center justify-end gap-x-6 gap-y-2 sm:gap-x-8">
        {active ? (
          <span className="mr-auto flex items-center gap-2 sm:mr-0">
            <span
              aria-hidden
              className="h-[7px] w-[7px] rounded-full bg-[color:var(--app-destructive)]"
            />
            <span className="text-[15px] font-medium tracking-[-0.2px] text-[color:var(--app-destructive)]">
              Live
            </span>
          </span>
        ) : null}
        <button
          type="button"
          onClick={onEditContacts}
          aria-label="Edit SMS contacts"
          className="press-scale flex items-center gap-[7px] text-[15px] tracking-[-0.2px] text-[color:var(--sos-label)] transition-colors hover:text-foreground"
        >
          <Plus className="h-[15px] w-[15px]" strokeWidth={1.8} aria-hidden />
          <span>Contacts</span>
        </button>
        <button
          type="button"
          onClick={onClose}
          className="press-scale text-[15px] tracking-[-0.2px] text-[color:var(--sos-label)] transition-colors hover:text-foreground"
        >
          Cancel
        </button>
      </div>

      {/* One centered column at every width. The ring, its label and the
          message controls scale together; nothing splits into a desktop grid. */}
      <div className="mt-8 flex flex-col items-center lg:mt-10">
        <div className="relative flex aspect-square w-[232px] items-center justify-center sm:w-[288px] lg:w-[344px]">
          {/* Ambient bloom behind the core — sized off the ring so it grows
              with it instead of needing its own breakpoints. */}
          <span
            aria-hidden
            className="pointer-events-none absolute h-[180%] w-[180%] rounded-full"
            style={{
              background:
                "radial-gradient(closest-side, rgb(var(--sos-glow-rgb) / 0.2), rgb(var(--sos-glow-rgb) / 0) 72%)",
            }}
          />

          {/* Alarm rings, emanating while the hold runs and while the alert is
              live. `vector-effect` keeps the stroke a true 2px/3px at every
              size, so the ring does not thin out on a phone. */}
          {showPulse ? (
            <>
              <span
                aria-hidden
                data-sos-pulse
                className="absolute h-[64%] w-[64%] rounded-full bg-[color:var(--app-destructive)]/40 [animation:sosRadarPulse_2.2s_ease-out_infinite]"
              />
              <span
                aria-hidden
                data-sos-pulse
                className="absolute h-[64%] w-[64%] rounded-full bg-[color:var(--app-destructive)]/40 [animation:sosRadarPulse_2.2s_ease-out_infinite] [animation-delay:0.73s]"
              />
              <span
                aria-hidden
                data-sos-pulse
                className="absolute h-[64%] w-[64%] rounded-full bg-[color:var(--app-destructive)]/40 [animation:sosRadarPulse_2.2s_ease-out_infinite] [animation-delay:1.46s]"
              />
            </>
          ) : null}

          {active ? (
            <>
              <span
                aria-hidden
                data-sos-pulse
                className="absolute inset-0 rounded-full border border-[color:var(--app-destructive)]/50 [animation:sosHalo_2.8s_cubic-bezier(0.4,0,0.2,1)_infinite]"
              />
              <span
                aria-hidden
                data-sos-pulse
                className="absolute inset-0 rounded-full border border-[color:var(--app-destructive)]/50 [animation:sosHalo_2.8s_cubic-bezier(0.4,0,0.2,1)_1.4s_infinite]"
              />
            </>
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
              // message) disable the control. When the sole blocker is "no SMS
              // contacts added" the button stays pressable, so the hold handler
              // can show an actionable toast instead of the press doing nothing.
              disabled={hardDisabled}
              aria-label="Press and hold for two seconds to send SMS"
              {...ringHold.pressHandlers}
              onContextMenu={(event) => event.preventDefault()}
              data-sos-core={busy ? "" : undefined}
              className={cn(
                "relative z-10 flex h-[81%] w-[81%] touch-none select-none items-center justify-center rounded-full text-[color:var(--app-destructive-fg)] outline-none",
                "transition-[transform,box-shadow] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background",
                ringHold.progress > 0 && "scale-[0.96]",
                busy && "[animation:sosCorePulse_2.2s_ease-in-out_infinite]",
                disabled && "cursor-not-allowed",
              )}
              style={{
                backgroundImage:
                  "linear-gradient(180deg, var(--sos-core-from) 0%, var(--sos-core-to) 100%)",
                boxShadow:
                  ringHold.progress > 0
                    ? "0 0 118px 16px rgb(var(--sos-glow-rgb) / 0.44), inset 0 1px 0 rgba(255,255,255,0.24)"
                    : "0 0 64px 4px rgb(var(--sos-glow-rgb) / 0.2), inset 0 1px 0 rgba(255,255,255,0.24)",
              }}
            >
              {/* "SMS", the name this feature carries everywhere else in the
                  product — the Location menu tile is "SMS / Save my soul", and
                  the outgoing message is an SMS. Only the visible glyph
                  changes: every identifier (data-testid, event name, scope
                  handle, backend enum) still says sos, because those are
                  contracts, not copy. */}
              <span className="text-[44px] font-semibold tracking-[1.5px] lg:text-[64px] lg:tracking-[2px]">
                SMS
              </span>
            </button>
          )}
        </div>

        <p
          data-testid="sos-status-label"
          className="mt-[26px] text-center text-[15px] tracking-[-0.2px] text-[color:var(--sos-label)] lg:mt-[34px] lg:text-[17px] lg:tracking-[-0.37px]"
        >
          {statusLabel}
        </p>

        {/* Who the SMS reaches. The design has no equivalent, but sending an
            emergency message to an audience you cannot see is not a thing to
            ask anyone to do. */}
        <p className="mt-2 max-w-full truncate px-2 text-center text-[13px] text-[color:var(--sos-label)]">
          {names ? `Alerts ${names}` : "No emergency contacts selected"}
        </p>

        <div className="mt-9 flex w-full max-w-[520px] flex-col gap-2.5 lg:mt-[52px] lg:gap-3">
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
              <p className="font-semibold">{busy ? "Sending" : "Alert sent"}</p>
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
              aria-describedby={
                customMessageLimitExceeded
                  ? "sos-short-message-count sos-short-message-error"
                  : "sos-short-message-count"
              }
              aria-invalid={customMessageLimitExceeded}
              value={customMessage}
              onChange={(event) => setCustomMessage(event.target.value)}
              readOnly={messageLocked}
              placeholder="Add a message"
              className={cn(
                // pr-14 reserves the send button's column so typed text never
                // runs underneath it.
                "h-[52px] w-full rounded-xl border bg-[color:var(--sos-control-surface)] pl-[18px] pr-14 text-[16px] tracking-[-0.3px] text-foreground outline-none placeholder:text-[color:var(--sos-placeholder)] lg:h-14 lg:pl-5 lg:text-[17px] lg:tracking-[-0.37px]",
                customMessageLimitExceeded
                  ? "border-[color:var(--app-destructive)]"
                  : "border-transparent focus:border-ring",
                messageLocked && "cursor-not-allowed opacity-60",
              )}
            />
            {/* Without this the only way to send a typed message was to go back
                up and hold the ring for two seconds, with nothing in the field
                confirming the text had been taken. Now a hold gate of its own
                (#5433): a typed message used to send on a single tap, which
                made this the one control on the screen where one accidental
                tap dispatched a real emergency broadcast. */}
            {sendHold.progress > 0 ? (
              <span
                role="status"
                className="pointer-events-none absolute -top-9 right-0 whitespace-nowrap rounded-full bg-[color:var(--sos-control-surface)] px-2.5 py-1 text-[12px] text-[color:var(--sos-label)] shadow-sm"
              >
                Hold to send…{" "}
                {((HOLD_DURATION_MS / 1000) * (1 - sendHold.progress)).toFixed(
                  1,
                )}
                s
              </span>
            ) : null}
            <button
              type="button"
              data-testid="sos-send-custom-message"
              disabled={hardDisabled || !selectedMessage}
              aria-label={
                sendHold.progress > 0
                  ? `Sending in ${(
                      (HOLD_DURATION_MS / 1000) *
                      (1 - sendHold.progress)
                    ).toFixed(1)} seconds, release to cancel`
                  : "Press and hold to send this SMS alert"
              }
              {...sendHold.pressHandlers}
              onContextMenu={(event) => event.preventDefault()}
              className={cn(
                "press-scale absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 touch-none select-none items-center justify-center rounded-full outline-none transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                // Solid emergency red is deliberate here and nowhere else in
                // the message box: this button IS the send, so it is the one
                // control whose consequence is the alert going out.
                hardDisabled || !selectedMessage
                  ? "bg-[color:var(--sos-control-surface-active)] text-[color:var(--sos-label)]"
                  : "bg-[color:var(--app-destructive)] text-[color:var(--app-destructive-fg)]",
              )}
            >
              <svg
                viewBox="0 0 40 40"
                aria-hidden
                className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
              >
                <circle
                  cx="20"
                  cy="20"
                  r={SEND_RING_RADIUS}
                  fill="none"
                  stroke="var(--sos-ring-track)"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx="20"
                  cy="20"
                  r={SEND_RING_RADIUS}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray={SEND_RING_CIRCUMFERENCE}
                  strokeDashoffset={
                    SEND_RING_CIRCUMFERENCE * (1 - sendHold.progress)
                  }
                />
              </svg>
              {busy ? (
                <Loader2 className="relative h-[18px] w-[18px] animate-spin" />
              ) : (
                <SendHorizontal
                  className="relative h-[18px] w-[18px]"
                  strokeWidth={2}
                />
              )}
            </button>
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
          </div>

          {/* While an alert is live the primary action becomes stopping it.
              This revokes the location grants the alert created AND clears the
              incident, so the live state resets here and in Active shares. */}
          {active ? (
            <button
              type="button"
              onClick={onStopSos}
              disabled={stopBusy}
              aria-label="Cancel the alert and stop sharing your location"
              data-testid="sos-cancel-alert"
              className="press-scale mt-1 flex h-[52px] w-full items-center justify-center gap-2 self-center rounded-xl bg-[color:var(--sos-control-surface)] text-[16px] text-[color:var(--sos-control-text)] transition-colors hover:bg-[color:var(--sos-control-surface-hover)] disabled:opacity-60 lg:h-14 lg:w-[220px] lg:text-[17px]"
            >
              {stopBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {stopBusy ? "Stopping…" : "Stop sharing"}
            </button>
          ) : null}
        </div>

        {/* The dialer. Outlined and tinted, never filled — it needs to read as
            tappable without becoming a peer of the SOS control.
            It had no surface at all and measured ~35px tall, under the 44px
            this product enforces everywhere else, on the one screen where the
            person is least able to aim. An outline buys the affordance; the
            filled treatment stays reserved for SOS. */}
        <div className="mt-10 flex min-h-[52px] items-center justify-center lg:mt-14">
          {emergencyStatus === "resolved" && emergency ? (
            shouldFallbackWindowsEmergencyCall ? (
              <button
                type="button"
                onClick={handleWindowsEmergencyCopy}
                aria-label={`Copy ${emergency.number} emergency services (${emergency.countryName})`}
                className="press-scale flex min-h-11 items-center gap-2.5 rounded-full border border-[color:var(--app-destructive)]/25 bg-[color:var(--app-destructive)]/8 px-4 py-2 text-[color:var(--app-destructive)] transition-colors hover:bg-[color:var(--app-destructive)]/14"
              >
                <Phone className="h-[17px] w-[17px] fill-current" aria-hidden />
                <span className="text-left leading-tight">
                  <span className="block text-[16px] font-medium tracking-[-0.3px] lg:text-[17px] lg:tracking-[-0.37px]">
                    {windowsCopyStatus === "copied"
                      ? `Copied ${emergency.number}`
                      : `Copy ${emergency.number}`}
                  </span>
                  <span className="block text-[12px] text-[color:var(--sos-label)]">
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
                className="press-scale flex min-h-11 items-center gap-2.5 rounded-full border border-[color:var(--app-destructive)]/25 bg-[color:var(--app-destructive)]/8 px-4 py-2 text-[color:var(--app-destructive)] transition-colors hover:bg-[color:var(--app-destructive)]/14"
              >
                <Phone className="h-[17px] w-[17px] fill-current" aria-hidden />
                <span className="text-left leading-tight">
                  <span className="block text-[16px] font-medium tracking-[-0.3px] lg:text-[17px] lg:tracking-[-0.37px]">
                    Call {emergency.number}
                  </span>
                  <span className="block text-[12px] text-[color:var(--sos-label)]">
                    {emergency.countryName}
                  </span>
                </span>
              </a>
            )
          ) : (
            <button
              type="button"
              onClick={onResolveEmergencyNumber}
              // "resolving" is the only state that must stay inert -- it means
              // a lookup is already in flight. "idle" (nothing looked up yet)
              // and "unavailable" (a lookup failed) both stay tappable, since
              // each needs the tap to be the thing that starts the next lookup.
              disabled={emergencyStatus === "resolving"}
              aria-label={
                emergencyStatus === "unavailable"
                  ? "Retry local emergency number"
                  : emergencyStatus === "resolving"
                    ? "Finding local emergency number"
                    : "Find local emergency number"
              }
              className="press-scale flex items-center gap-2.5 text-[color:var(--app-destructive)] transition-opacity hover:opacity-70 disabled:cursor-wait disabled:opacity-75"
            >
              {emergencyStatus === "resolving" ? (
                <Loader2
                  className="h-[17px] w-[17px] animate-spin"
                  aria-hidden
                />
              ) : (
                <Phone className="h-[17px] w-[17px] fill-current" aria-hidden />
              )}
              <span className="text-left leading-tight">
                <span className="block text-[16px] font-medium tracking-[-0.3px] lg:text-[17px] lg:tracking-[-0.37px]">
                  {emergencyStatus === "unavailable"
                    ? "Retry local number"
                    : emergencyStatus === "resolving"
                      ? "Finding local number"
                      : "Find local number"}
                </span>
                <span className="block text-[12px] text-[color:var(--sos-label)]">
                  {emergencyStatus === "unavailable"
                    ? "Location unavailable"
                    : emergencyStatus === "resolving"
                      ? "Using current location"
                      : "Tap to look up"}
                </span>
              </span>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
