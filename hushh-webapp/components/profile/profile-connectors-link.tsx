"use client";

import {
  forwardRef,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type RefObject,
} from "react";
import Link from "next/link";

import {
  buildProfileConnectorsPaneHref,
  openProfilePane,
  profileConnectorsLocation,
} from "@/lib/navigation/profile-pane";

type ProfileConnectorsLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  /** Open straight onto one connector, for example "google_drive". */
  connectorId?: string | null;
  /** Persistent origin control when this link is inside a closing dialog. */
  returnFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Opens Connectors in the Profile pane over the screen the person is on, and
 * Back from there returns to that screen. The href is a real address to the
 * same section, so a modified click (new tab, new window) still lands there.
 */
export const ProfileConnectorsLink = forwardRef<
  HTMLAnchorElement,
  ProfileConnectorsLinkProps
>(function ProfileConnectorsLink({ connectorId, returnFocusRef, onClick, ...props }, ref) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    openProfilePane(
      window.location.pathname,
      window.location.search,
      profileConnectorsLocation(connectorId),
      { returnsToOrigin: true, returnFocus: returnFocusRef?.current ?? event.currentTarget },
    );
  };
  return (
    <Link
      ref={ref}
      href={buildProfileConnectorsPaneHref(connectorId)}
      onClick={handleClick}
      {...props}
    />
  );
});
