"use client";

import { memo } from "react";
import { UserRound } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  projectToMapBox,
  type MapNameLabelCamera,
  type MapNameLabelViewport,
} from "@/lib/one-location/map-name-labels";

/**
 * The current user's own position on Your Map, drawn as their avatar.
 *
 * ## Why this is HTML and not a renderer marker
 *
 * The product already knows who this person is, so a generic pin is the one
 * marker on the map that says nothing. Replacing it needs a circular photo, a
 * white keyline and a coloured ring -- and `@capacitor/google-maps` exposes
 * exactly one styling knob per marker, `tintColor`. Its `iconUrl` cannot help
 * either: the iOS bridge accepts an `https:` URL or a file bundled under
 * `public/`, so a locally composed avatar (which is what a ring around a photo
 * is) has nowhere to live, and it re-fetches the image on every marker pass.
 *
 * So this follows the pattern the map already established for name pills in
 * `map-name-labels.tsx`: project the coordinate into the map box with
 * `projectToMapBox` and draw HTML over the renderer. Same projection, same
 * camera, same staleness rule -- one more layer, not a second mechanism.
 *
 * ## What it deliberately keeps from the pin it replaces
 *
 * - **The tap.** The renderer's marker-click handler selected the marker and
 *   moved the camera to zoom 15. This is a real button that calls the same
 *   thing, at a 44 px target instead of a pin's tip.
 * - **Staleness.** A position older than the server's freshness window turned
 *   the pin grey. The ring carries that here; the photo is never greyed,
 *   because a dimmed face reads as a broken image rather than an old fix.
 * - **Privacy.** No name, no label, nothing that could reach the renderer. The
 *   avatar is rendered by the WebView from a URL the app already holds for the
 *   top bar and the profile screen.
 *
 * Renders nothing when the camera has not reported yet, or when the coordinate
 * falls outside the map box -- a marker half off the edge is worse than none,
 * and clamping it would put the person somewhere they are not.
 */

/** Diameter of the photo itself. */
export const SELF_AVATAR_PHOTO_SIZE_PX = 36;

/** Diameter of the whole marker including the keyline and ring. */
export const SELF_AVATAR_MARKER_SIZE_PX = 44;

export interface MapSelfAvatarMarkerProps {
  point: { latitude: number; longitude: number };
  camera: MapNameLabelCamera | null;
  viewport: MapNameLabelViewport;
  /** The app's existing avatar URL for this user. Null falls back to initials. */
  avatarUrl: string | null;
  /** Used only for the initials fallback and the accessible name. */
  displayName: string | null;
  /** Position is older than the server's freshness window. */
  stale?: boolean;
  /**
   * The camera is mid-gesture and the coordinates below describe where it WAS.
   * Only iOS and Android set this, for the same reason the name pills do.
   */
  stalePositions?: boolean;
  onSelect?: () => void;
}

function initialsOf(name: string | null): string {
  const parts = (name ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function MapSelfAvatarMarkerImpl({
  point,
  camera,
  viewport,
  avatarUrl,
  displayName,
  stale,
  stalePositions,
  onSelect,
}: MapSelfAvatarMarkerProps) {
  if (!camera) return null;
  const anchor = projectToMapBox(point, camera, viewport);
  if (!anchor) return null;
  if (
    anchor.x < 0 ||
    anchor.y < 0 ||
    anchor.x > viewport.width ||
    anchor.y > viewport.height
  ) {
    return null;
  }

  const initials = initialsOf(displayName);

  return (
    <button
      type="button"
      data-testid="one-location-map-self-avatar"
      data-stale={stale ? "true" : undefined}
      // "Your location" and nothing more. The renderer's own pin announced the
      // same two words; adding the person's name here would say out loud, on
      // the one surface built around not doing that, who the map belongs to.
      aria-label="Your location"
      onClick={onSelect}
      // z-10 puts it in the same band as the name pills and keeps it under the
      // people tray (z-20) and the top controls (z-30), which are things you
      // press. Later in the DOM than the pills, so it paints over a name that
      // lands on top of it rather than under one.
      className={`absolute left-0 top-0 z-10 flex touch-manipulation items-center justify-center rounded-full p-0 transition-opacity duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 motion-reduce:transition-none ${
        stalePositions ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      style={{
        width: SELF_AVATAR_MARKER_SIZE_PX,
        height: SELF_AVATAR_MARKER_SIZE_PX,
        // A transform, not left/top: web reports the camera every frame of a
        // pan, and a compositor-only property is what keeps this tracking the
        // map without a layout pass per frame. Centred on the coordinate --
        // this is a "you are here" puck, not a pin whose tip marks the spot.
        transform: `translate3d(${anchor.x}px, ${anchor.y}px, 0) translate(-50%, -50%)`,
      }}
    >
      {/*
        The ring. Drawn as its own inset ring rather than a border on the photo
        so the photo keeps its full diameter at every zoom, and so staleness can
        change one colour without touching the image.
      */}
      <span
        aria-hidden="true"
        className={`absolute inset-0 rounded-full ${
          stale
            ? "bg-[color:var(--muted-foreground)]/35"
            : "bg-[color:var(--app-accent)]/30"
        }`}
      />
      <span
        aria-hidden="true"
        className="absolute inset-[3px] rounded-full bg-white shadow-[0_1px_4px_rgba(60,64,67,0.30),0_1px_2px_rgba(60,64,67,0.18)] dark:bg-background"
      />
      <Avatar
        className="relative"
        style={{
          width: SELF_AVATAR_PHOTO_SIZE_PX,
          height: SELF_AVATAR_PHOTO_SIZE_PX,
        }}
      >
        {avatarUrl ? (
          <AvatarImage
            src={avatarUrl}
            alt=""
            data-testid="one-location-map-self-avatar-photo"
          />
        ) : null}
        {/*
          The app's existing fallback, same order as the top bar: initials when
          there is a name to take them from, the profile glyph when there is
          not. No third placeholder system.
        */}
        <AvatarFallback
          data-testid="one-location-map-self-avatar-fallback"
          className="bg-[color:var(--app-accent)] text-[13px] font-semibold leading-none text-[color:var(--app-accent-fg)]"
        >
          {initials || <UserRound className="h-4 w-4" aria-hidden />}
        </AvatarFallback>
      </Avatar>
    </button>
  );
}

export const MapSelfAvatarMarker = memo(MapSelfAvatarMarkerImpl);
