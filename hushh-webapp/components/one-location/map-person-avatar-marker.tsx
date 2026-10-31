"use client";

import type { ComponentProps } from "react";
import { createPortal } from "react-dom";
import { MapAvatarFace, MapSelfAvatarMarker, SELF_AVATAR_MARKER_SIZE_PX } from "./map-self-avatar-marker";

type Props = Omit<ComponentProps<typeof MapSelfAvatarMarker>, "rendererOverlay" | "testId" | "anchor"> & {
  rendererElement: HTMLElement | null;
};

export function MapPersonAvatarMarker({ rendererElement, ...props }: Props) {
  if (rendererElement) {
    // AdvancedMarker owns the anchor and existing SDK click listener. This is
    // presentation only: no second button or camera action inside the marker.
    return createPortal(
      <span
        aria-hidden="true"
        data-testid="one-location-map-person-avatar"
        data-stale={props.stale ? "true" : undefined}
        className="relative flex items-center justify-center"
        style={{ width: SELF_AVATAR_MARKER_SIZE_PX, height: SELF_AVATAR_MARKER_SIZE_PX }}
      >
        <MapAvatarFace avatarUrl={props.avatarUrl} displayName={props.displayName}
          stale={props.stale} testId="one-location-map-person-avatar" />
      </span>,
      rendererElement,
    );
  }
  return <MapSelfAvatarMarker {...props} anchor="pin" testId="one-location-map-person-avatar" />;
}
