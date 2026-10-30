"use client";

import Link from "next/link";
import { type AnchorHTMLAttributes, type MouseEvent } from "react";
import { buildProfilePaneHref, openProfilePane, type ProfilePaneLocation } from "@/lib/navigation/profile-pane";

const ACCOUNT: ProfilePaneLocation = { panel: "account", detail: null };
const PAYMENTS: ProfilePaneLocation = { panel: "payouts", detail: null };

type ProfileLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

/** Account opens over the current screen; Back returns to the originating review. */
function ProfilePanelLink({ destination, onClick, ...props }: ProfileLinkProps & { destination: ProfilePaneLocation }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openProfilePane(window.location.pathname, window.location.search, destination, { returnsToOrigin: true });
  };
  return <Link href={buildProfilePaneHref("/one", null, destination)} onClick={handleClick} {...props} />;
}

export function ProfileAccountLink(props: ProfileLinkProps) {
  return <ProfilePanelLink destination={ACCOUNT} {...props} />;
}

export function ProfilePaymentsLink(props: ProfileLinkProps) {
  return <ProfilePanelLink destination={PAYMENTS} {...props} />;
}
