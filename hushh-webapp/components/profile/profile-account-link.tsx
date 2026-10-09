"use client";

import Link from "next/link";
import { type AnchorHTMLAttributes, type MouseEvent } from "react";
import { buildProfilePaneHref, openProfilePane, type ProfilePaneLocation } from "@/lib/navigation/profile-pane";

const ACCOUNT: ProfilePaneLocation = { panel: "account", detail: null };

/** Account opens over the current screen; Back returns to the originating review. */
export function ProfileAccountLink({ onClick, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openProfilePane(window.location.pathname, window.location.search, ACCOUNT, { returnsToOrigin: true });
  };
  return <Link href={buildProfilePaneHref("/one", null, ACCOUNT)} onClick={handleClick} {...props} />;
}
