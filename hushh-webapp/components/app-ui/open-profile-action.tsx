"use client";

import { UserRound } from "@/components/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { requestProfilePaneOpen } from "@/lib/navigation/profile-pane";
import { ShellActionSurface } from "./shell-action-surface";

/** The signed-in Profile trigger shared by the top shell and route-owned headers. */
export function OpenProfileAction({ avatarUrl, displayName }: {
  avatarUrl?: string | null;
  displayName?: string | null;
}) {
  const initials = displayName?.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return <ShellActionSurface
    variant="avatar"
    aria-label="Open Profile"
    onClick={(event) => requestProfilePaneOpen("tap", event.currentTarget)}
  >
    <Avatar className="h-8 w-8">
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
      <AvatarFallback className="bg-transparent text-[15px] font-semibold leading-5 text-current">
        {initials || <UserRound className="h-5 w-5" />}
      </AvatarFallback>
    </Avatar>
  </ShellActionSurface>;
}
