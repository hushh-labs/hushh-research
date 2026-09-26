"use client";

import { memo, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { UserRound } from "@/components/icons";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { WebSelfAvatarOverlay } from "@/lib/one-location/web-self-avatar-overlay";
import {
  projectToMapBox,
  type MapNameLabelCamera,
  type MapNameLabelViewport,
} from "@/lib/one-location/map-name-labels";

/**
 * The current user's own position on Your Map and Check-in, drawn as their
 * avatar.
 *
 * ## Why this is HTML and not a renderer marker
 *
 * The product already knows who this person is, so a generic pin is the one
 * marker on the map that says nothing. Replacing it needs a circular photo, a
 * white keyline and a coloured ring -- and `@capacitor/google-maps` exposes
 * exactly one styling knob per marker, `tintColor`. Its `iconUrl` cannot help
 * either: the iOS bridge accepts an `https:` URL or a file bundled under
 * `public/`, so a locally composed avatar (which is what a ring around a photo
 * is) has nowhere to live. Renderer markers also join global clustering.
 *
 * On web, a Google OverlayView owns the transform and the same React photo
 * stays in its map pane throughout gestures. Native retains the safe settled
 * projection because its bridge does not expose an equivalent HTML map pane.
 * The native fallback follows the pattern already established for name pills in
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
 * The semantic button stays mounted while the map owns a self location. When
 * the camera is moving, unsafe to project, or the coordinate is off-screen,
 * only its visual avatar is hidden. This preserves keyboard focus across the
 * handoff to the renderer-owned geographic fallback without clamping the owner
 * somewhere they are not.
 */

/** Diameter of the photo itself. */
export const SELF_AVATAR_PHOTO_SIZE_PX = 36;

/** Diameter of the whole marker including the keyline and ring. */
export const SELF_AVATAR_MARKER_SIZE_PX = 44;

/** The compact avatar key used by the nearby Check-in map legend. */
export const SELF_AVATAR_LEGEND_SIZE_PX = 18;

export interface MapSelfAvatarMarkerProps {
  point: { latitude: number; longitude: number };
  camera: MapNameLabelCamera | null;
  rendererOverlay?: WebSelfAvatarOverlay | null;
  viewport: MapNameLabelViewport;
  /** The app's existing avatar URL for this user. Null falls back to initials. */
  avatarUrl: string | null;
  /** Used only for the initials fallback and the accessible name. */
  displayName: string | null;
  /** What this presentation marker represents. Defaults to the live device fix. */
  accessibleLabel?: string;
  /** Position is older than the server's freshness window. */
  stale?: boolean;
  /** The settled camera can safely own the visible HTML avatar. */
  showAvatar?: boolean;
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

export interface MapSelfAvatarLegendProps {
  /** The app's existing avatar URL for this user. */
  avatarUrl: string | null;
  /** Used for the initials fallback. */
  displayName: string | null;
  /** Position is older than the server's freshness window. */
  stale?: boolean;
}

/**
 * The legend key for the owner's map marker.
 *
 * Keep this visually related to `MapSelfAvatarMarker` without rendering the
 * marker-sized button: the legend is explanatory content, not another map
 * control. Using the same avatar source means the key cannot drift back to a
 * blue key after the map marker becomes a face.
 */
export function MapSelfAvatarLegend({
  avatarUrl,
  displayName,
  stale,
}: MapSelfAvatarLegendProps) {
  const initials = initialsOf(displayName);

  return (
    <span
      aria-hidden="true"
      data-testid="one-location-map-self-avatar-legend"
      className="relative inline-flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: SELF_AVATAR_LEGEND_SIZE_PX,
        height: SELF_AVATAR_LEGEND_SIZE_PX,
      }}
    >
      <span
        className={`absolute inset-0 rounded-full ${
          stale
            ? "bg-[color:var(--muted-foreground)]/35"
            : "bg-[color:var(--app-accent)]/30"
        }`}
      />
      <span className="absolute inset-[1px] rounded-full bg-white dark:bg-background" />
      <Avatar
        className="relative"
        style={{
          width: SELF_AVATAR_LEGEND_SIZE_PX - 2,
          height: SELF_AVATAR_LEGEND_SIZE_PX - 2,
        }}
      >
        {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
        <AvatarFallback className="bg-[color:var(--app-accent)] text-[7px] font-semibold leading-none text-[color:var(--app-accent-fg)]">
          {initials || <UserRound className="h-2.5 w-2.5" aria-hidden />}
        </AvatarFallback>
      </Avatar>
    </span>
  );
}

function MapSelfAvatarMarkerImpl({
  point,
  camera,
  rendererOverlay,
  viewport,
  avatarUrl,
  displayName,
  accessibleLabel = "Your location",
  stale,
  showAvatar = true,
  onSelect,
}: MapSelfAvatarMarkerProps) {
  useLayoutEffect(() => {
    rendererOverlay?.setPoint(point);
  }, [rendererOverlay, point]);
  const anchor = camera ? projectToMapBox(point, camera, viewport) : null;
  const visibleAnchor = rendererOverlay
    ? { x: 0, y: 0 }
    : showAvatar &&
        anchor &&
        anchor.x >= 0 &&
        anchor.y >= 0 &&
        anchor.x <= viewport.width &&
        anchor.y <= viewport.height
      ? anchor
      : null;

  const initials = initialsOf(displayName);

  const marker = (
    <button
      type="button"
      data-testid="one-location-map-self-avatar"
      data-stale={stale ? "true" : undefined}
      // Do not announce the person's name. On Your Map this remains the live
      // device fix; an active Check-in may instead describe the public venue
      // where the owner intentionally chose to appear.
      aria-label={accessibleLabel}
      onClick={onSelect}
      // z-10 puts the visible avatar in the same band as the name pills and
      // under the people tray/top controls. During the renderer handoff this
      // exact button becomes a keyboard-focus-revealed chip, so focus is never
      // discarded by unmounting and remounting two different controls. Pointer
      // focus stays visually hidden while the renderer owns camera motion.
      className={
        visibleAnchor
          ? "absolute left-0 top-0 z-10 flex touch-manipulation items-center justify-center rounded-full p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2"
          : "sr-only focus-visible:not-sr-only focus-visible:pointer-events-auto focus-visible:absolute focus-visible:left-4 focus-visible:top-24 focus-visible:z-40 focus-visible:rounded-full focus-visible:bg-background focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:shadow-lg"
      }
      style={
        visibleAnchor
          ? {
              width: SELF_AVATAR_MARKER_SIZE_PX,
              height: SELF_AVATAR_MARKER_SIZE_PX,
              // A transform, not left/top: camera updates do not need layout.
              // Centred on the coordinate -- this is a puck, not a pin whose
              // tip marks the spot.
              transform: `translate3d(${visibleAnchor.x}px, ${visibleAnchor.y}px, 0) translate(-50%, -50%)`,
            }
          : undefined
      }
    >
      {visibleAnchor ? (
        <>
          {/*
            The ring. Drawn as its own inset ring rather than a border on the
            photo so staleness can change one colour without touching the face.
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
              The app's existing fallback, same order as the top bar: initials
              when there is a name, the profile glyph when there is not.
            */}
            <AvatarFallback
              data-testid="one-location-map-self-avatar-fallback"
              className="bg-[color:var(--app-accent)] text-[13px] font-semibold leading-none text-[color:var(--app-accent-fg)]"
            >
              {initials || <UserRound className="h-4 w-4" aria-hidden />}
            </AvatarFallback>
          </Avatar>
        </>
      ) : (
        accessibleLabel
      )}
    </button>
  );
  return rendererOverlay
    ? createPortal(marker, rendererOverlay.element)
    : marker;
}

export const MapSelfAvatarMarker = memo(MapSelfAvatarMarkerImpl);
