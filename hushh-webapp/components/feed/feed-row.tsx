"use client";

import { PersonSelectionSurface } from "@/components/connections/person-selection-surface";
import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { toast } from "sonner";
import { PeoplePairIcon } from "@/components/icons";

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
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import { FeedRowMetadata, FeedRowTimestamp } from "./feed-row-metadata";
import type { FeedItem } from "@/lib/services/feed-service";

const SWIPE_LIMIT_PX = 132;
const SWIPE_COMMIT_PX = 84;
const SWIPE_AXIS_LOCK_PX = 10;
const HOLD_TO_CONFIRM_MS = 600;

type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  axis: "pending" | "horizontal" | "vertical";
  held: boolean;
};

function FeedGlyph({ eventType }: { eventType: string }) {
  const icon = eventType.startsWith("calendar_")
    ? "calendar"
    : eventType.startsWith("drive_") || eventType.startsWith("connector_")
      ? "drive"
      : eventType.startsWith("document_share_")
        ? "file"
        : eventType.startsWith("circle_") ||
            eventType.startsWith("location_circle_") ||
            eventType.startsWith("connection_")
          ? "people"
          : eventType.startsWith("location_")
            ? "pin"
            : eventType.startsWith("funding_")
              ? "card"
              : null;
  if (!icon) return null;
  if (icon === "people") return <PeoplePairIcon size={22} />;

  const accent = "var(--app-accent)";
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icon === "calendar" ? (
        <>
          <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
          <path stroke={accent} d="M3.5 9.8h17" />
          <path d="M8 2.8v3.6M16 2.8v3.6" />
          <circle cx="12" cy="14.9" r="1.7" fill={accent} stroke="none" />
        </>
      ) : icon === "drive" ? (
        <>
          <ellipse cx="12" cy="6" rx="7" ry="2.8" />
          <path d="M5 6v12c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9V6" />
          <path stroke={accent} d="M5 12c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9" />
        </>
      ) : icon === "file" ? (
        <>
          <path d="M7 3h7l5 5v12H7zM14 3v5h5" />
          <path stroke={accent} d="M9.5 13h5M9.5 16.5h3.5" />
        </>
      ) : icon === "pin" ? (
        <>
          <path d="M12 21.2s-6.8-5.6-6.8-10.7a6.8 6.8 0 0 1 13.6 0c0 5.1-6.8 10.7-6.8 10.7Z" />
          <circle cx="12" cy="10.3" r="2.4" stroke={accent} />
        </>
      ) : (
        <>
          <rect x="3" y="6" width="18" height="13" rx="3" />
          <path stroke={accent} d="M3 10.3h18" />
          <rect x="6.5" y="13.2" width="3.6" height="2.8" rx=".9" stroke={accent} />
        </>
      )}
    </svg>
  );
}

/** A live history row. Removal belongs to the server; this component never edits the list. */
export const FeedRow = memo(function FeedRow({
  item,
  onOpen,
  onRemove,
  onKeep,
  removeDirection = "left",
  removing = false,
  unread,
}: {
  item: FeedItem;
  onOpen: (item: FeedItem) => void;
  onRemove?: (item: FeedItem) => void | Promise<void>;
  onKeep?: (item: FeedItem) => void;
  /** The row's gesture can follow a product-level direction choice. */
  removeDirection?: "left" | "right";
  removing?: boolean;
  unread?: boolean;
}) {
  const presentation = presentFeedItem(item);
  const read = unread === undefined ? item.read : !unread;
  const hasRoute = Boolean(presentation.href);
  const canRemove = Boolean(onRemove);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mutating, setMutating] = useState(false);
  const surfaceRef = useRef<HTMLButtonElement | null>(null);
  const paintedSurfaceRef = useRef<HTMLDivElement | null>(null);
  const keepRevealRef = useRef<HTMLDivElement | null>(null);
  const removeRevealRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);
  const removingRef = useRef(false);
  const hintId = useId();
  const descriptionId = useId();
  const busy = removing || mutating;
  const removeSign = removeDirection === "left" ? -1 : 1;

  const clearHold = () => {
    if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  };

  useEffect(() => () => {
    if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
  }, []);

  const paintSwipe = (offset: number) => {
    const surface = paintedSurfaceRef.current;
    if (surface) surface.style.transform = `translate3d(${offset}px,0,0)`;
    if (removeRevealRef.current) {
      removeRevealRef.current.style.opacity = String(
        Math.max(0, Math.min(1, (offset * removeSign) / SWIPE_COMMIT_PX)),
      );
    }
    if (keepRevealRef.current) {
      keepRevealRef.current.style.opacity = String(
        Math.max(0, Math.min(1, (-offset * removeSign) / SWIPE_COMMIT_PX)),
      );
    }
  };

  const resetGesture = () => {
    clearHold();
    gestureRef.current = null;
    if (paintedSurfaceRef.current) paintedSurfaceRef.current.style.transition = "";
    paintSwipe(0);
  };

  const runRemove = async () => {
    if (!onRemove || busy || removingRef.current) return;
    removingRef.current = true;
    setMutating(true);
    try {
      await onRemove(item);
    } catch {
      toast.error("Couldn't remove this item. Try again.");
    } finally {
      removingRef.current = false;
      setMutating(false);
      setConfirmOpen(false);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canRemove || busy || event.isPrimary === false) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // A new press is distinct from any cancelled gesture's possible click.
    suppressClickRef.current = false;
    // The native iOS edge gesture owns the first 28px of the viewport.
    if (event.pointerType === "touch" && event.clientX <= 28) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      axis: "pending",
      held: false,
    };
    clearHold();
    holdTimerRef.current = setTimeout(() => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.axis !== "pending") return;
      gesture.held = true;
      suppressClickRef.current = true;
      setConfirmOpen(true);
    }, HOLD_TO_CONFIRM_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.held) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (gesture.axis === "pending") {
      if (Math.hypot(deltaX, deltaY) < SWIPE_AXIS_LOCK_PX) return;
      clearHold();
      gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
      if (gesture.axis === "vertical") return;
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Implicit touch capture still carries the gesture on WebKit.
      }
      if (paintedSurfaceRef.current) paintedSurfaceRef.current.style.transition = "none";
    }
    if (gesture.axis !== "horizontal") return;
    gesture.dx = Math.max(-SWIPE_LIMIT_PX, Math.min(SWIPE_LIMIT_PX, deltaX));
    paintSwipe(gesture.dx);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const { axis, dx: releasedDx, held } = gesture;
    resetGesture();
    if (held || axis === "vertical") {
      suppressClickRef.current = true;
      return;
    }
    if (axis !== "horizontal") return;
    suppressClickRef.current = true;
    if (releasedDx * removeSign >= SWIPE_COMMIT_PX) {
      void runRemove();
    } else if (releasedDx * removeSign <= -SWIPE_COMMIT_PX) {
      onKeep?.(item);
    }
  };

  const onPointerCancel = () => {
    // A cancelled gesture is always a no-op, even when it passed the threshold.
    if (gestureRef.current) suppressClickRef.current = true;
    resetGesture();
  };

  const icon = <FeedGlyph eventType={item.event_type} />;
  const Icon = presentation.icon;
  const surfaceLabel = hasRoute
    ? `Open ${presentation.label}`
    : canRemove
      ? `Remove ${presentation.label} from feed`
      : presentation.label;

  return (
    <div
      data-testid="feed-row"
      data-no-route-swipe
      data-swipe-direction={removeDirection}
      className="group/feed-row relative isolate overflow-hidden bg-transparent after:pointer-events-none after:absolute after:bottom-0 after:left-11 after:right-0 after:h-px after:bg-[color:var(--app-separator)] after:content-[''] last:after:hidden"
    >
      {canRemove ? (
        <>
          <div
            ref={keepRevealRef}
            data-slot="feed-swipe-keep"
            aria-hidden="true"
            style={{ opacity: 0 }}
            className={`pointer-events-none absolute inset-0 flex items-center gap-2 bg-[color:var(--app-accent-tint)] px-[18px] text-xs font-semibold text-[color:var(--app-accent)] ${removeDirection === "left" ? "justify-start" : "justify-end"}`}
          >
            <svg viewBox="0 0 24 24" className="size-[17px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4.5 12.5 5 5 10-11" /></svg>
            Keep
          </div>
          <div
            ref={removeRevealRef}
            data-slot="feed-swipe-remove"
            aria-hidden="true"
            style={{ opacity: 0 }}
            className={`pointer-events-none absolute inset-0 flex items-center gap-2 bg-[color:var(--app-destructive-tint)] px-[18px] text-xs font-semibold text-[color:var(--app-destructive)] ${removeDirection === "left" ? "justify-end" : "justify-start"}`}
          >
            Remove
            <svg viewBox="0 0 24 24" className="size-[17px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </div>
        </>
      ) : null}
      <PersonSelectionSurface surfaceRef={paintedSurfaceRef}
        ref={surfaceRef}
        type="button"
        disabled={busy || (!hasRoute && !canRemove)}
        aria-label={surfaceLabel}
        aria-describedby={[presentation.description ? descriptionId : null, canRemove ? hintId : null].filter(Boolean).join(" ") || undefined}
        aria-keyshortcuts={canRemove ? "Delete Backspace" : undefined}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            event.preventDefault();
            return;
          }
          if (hasRoute) onOpen(item);
          else if (canRemove) setConfirmOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") suppressClickRef.current = false;
          if (!canRemove || (event.key !== "Delete" && event.key !== "Backspace")) return;
          event.preventDefault();
          setConfirmOpen(true);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(event) => {
          if (!canRemove) return;
          event.preventDefault();
          setConfirmOpen(true);
        }}
        style={{ transform: "translate3d(0px,0,0)" }}
        className={`relative z-[1] grid min-h-[52px] w-full grid-cols-[30px_minmax(0,1fr)_auto_14px] items-center gap-x-2 border-0 bg-[color:var(--app-card-surface-default-solid)] px-3 py-1.5 text-left text-[color:var(--app-label)] outline-none transition-transform duration-300 ease-[cubic-bezier(.2,.9,.2,1)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent)] data-[disabled=false]:cursor-pointer [&:not([data-disabled])]:hover:bg-[color:var(--app-accent-tint)] data-[disabled=true]:cursor-default motion-reduce:transition-none max-[360px]:gap-x-[7px] max-[360px]:px-[9px] ${canRemove ? "touch-pan-y" : ""}`}
      >
        <span className="grid w-[30px] place-items-center">
          {presentation.person ? (
            <ConnectionPersonAvatar personRef={presentation.person.personRef}
              label={presentation.person.displayName}
              photoUrl={presentation.person.photoUrl}
              size="compact"
              className="size-[26px]"
            />
          ) : (
            <span data-slot="feed-domain-icon" aria-hidden="true" className="grid size-[22px] place-items-center text-[color:var(--app-label)] [&_svg]:size-[22px]">
              {icon ?? <Icon className="size-[22px]" color="currentColor" />}
            </span>
          )}
        </span>
        <FeedRowMetadata title={<span data-slot="settings-row-title" data-profile-role="name" data-feed-unread={!read ? "true" : undefined} className="block truncate">{!read ? <span className="sr-only">Unread: </span> : null}{presentation.label}</span>}
          description={presentation.description} descriptionId={descriptionId} />
        <span className="flex shrink-0 items-center gap-1">
          {!read ? <span data-slot="feed-unread-marker" data-state="unread" aria-hidden="true" className="size-1.5 rounded-full bg-[color:var(--app-accent)]" /> : null}
          <FeedRowTimestamp timestamp={item.created_at} />
        </span>
        <span aria-hidden="true" className="grid size-[14px] place-items-center text-[color:var(--app-tertiary-label)]">
          {hasRoute ? <svg viewBox="0 0 24 24" className="size-[14px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg> : null}
        </span>
      </PersonSelectionSurface>
      {canRemove ? <span id={hintId} className="sr-only">Swipe {removeDirection} to remove, swipe {removeDirection === "left" ? "right" : "left"} to keep, or press and hold to confirm removal.</span> : null}
      {canRemove ? (
        <AlertDialog open={confirmOpen} onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) suppressClickRef.current = false;
        }}>
          <AlertDialogContent size="sm" data-profile-type-scale="feed">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove from feed?</AlertDialogTitle>
              <AlertDialogDescription>{presentation.label}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void runRemove()}>Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
});
