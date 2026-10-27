"use client";

import { Loader2, LocateFixed, UsersRound, X } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";

type Base = { owner: string | null; toneClassName: string };
export function LocationMapCloseControl({ owner, toneClassName, closing, onClose }: Base & { closing: boolean; onClose: () => void }) {
  return <ShellActionSurface className={`pointer-events-auto !h-14 !w-14 touch-manipulation border shadow-lg backdrop-blur-md ${toneClassName}`}
    aria-label="Back to Location" data-testid="one-location-map-close" disabled={closing} onClick={onClose}
    nativeAction={{ kind: "map-close", owner, context: "immersive-map-close", label: "Back to Location", onActivate: onClose }}
    onPointerUp={event => { if (event.pointerType === "touch" || event.pointerType === "pen") onClose(); }}>
    <X className="h-5 w-5 stroke-[2.25]" />
  </ShellActionSurface>;
}
export function LocationMapCheckInControl({ owner, toneClassName, checkedIn, count, onOpen }: Base & { checkedIn: boolean; count: number; onOpen: () => void }) {
  return <ShellActionSurface variant="pill" wrapperClassName="min-w-0 shrink"
    className={`pointer-events-auto min-w-0 border shadow-lg backdrop-blur-md ${toneClassName}`}
    aria-label={checkedIn ? `Checked in${count > 0 ? `, ${count} nearby` : ""}` : "Check in nearby"}
    nativeAction={{ kind: "map-check-in", owner, context: "immersive-map-check-in", label: "Check in nearby", value: checkedIn ? "active" : "idle", onActivate: onOpen }}
    data-testid="one-location-map-nearby-check-in" onClick={onOpen}>
    <UsersRound className="h-4 w-4 shrink-0" />
    <span data-location-type-role="compact-action" className="truncate">{checkedIn ? "Checked in" : "Check in"}</span>
  </ShellActionSurface>;
}
export function LocationMapLocateControl({ owner, toneClassName, busy, placeFocused, onLocate }: Base & { busy: boolean; placeFocused: boolean; onLocate: () => void }) {
  return <ShellActionSurface className={`pointer-events-auto !h-14 !w-14 touch-manipulation border shadow-lg backdrop-blur-md ${toneClassName}`}
    aria-label={busy ? placeFocused ? "Centering your check-in place" : "Finding your location" : placeFocused ? "Show my check-in place" : "Show my location"}
    aria-busy={busy} data-testid="one-location-map-locate" disabled={busy} onClick={onLocate}
    nativeAction={{ kind: "map-locate", owner, context: "immersive-map-locate", label: placeFocused ? "Show my check-in place" : "Show my location", onActivate: onLocate }}>
    {busy ? <Loader2 className="h-5 w-5 animate-spin stroke-[2.25]" aria-hidden="true" /> : <LocateFixed className="h-5 w-5 stroke-[2.25]" />}
  </ShellActionSurface>;
}
