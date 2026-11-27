"use client";

import { useState } from "react";
import { BadgeCheck, ContactsBookIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export const CONNECTION_BADGE_DESCRIPTIONS = {
  advisor: "Advisor verified by Hussh.",
  contacts: "Matched from your contacts.",
} as const;

export function ConnectionStatusBadge({ verified, interactive = true, className, iconClassName }: {
  verified?: boolean;
  interactive?: boolean;
  className?: string;
  iconClassName?: string;
}) {
  const label = verified ? "Verified Advisor" : "Via contacts";
  const description = verified ? CONNECTION_BADGE_DESCRIPTIONS.advisor : CONNECTION_BADGE_DESCRIPTIONS.contacts;
  const Icon = verified ? BadgeCheck : ContactsBookIcon;
  const badgeClassName = cn("inline-grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground", className);
  const glyph = <Icon aria-hidden="true" className={cn("size-4", verified && "text-[color:var(--app-success,#16a34a)]", iconClassName)} />;
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        {interactive ? (
          <button
            type="button"
            aria-label={label}
            className={cn(badgeClassName, "focus-visible:ring-2 focus-visible:ring-ring")}
            onClick={() => setOpen(true)}
            onBlur={() => setOpen(false)}
          >
            {glyph}
          </button>
        ) : (
          <span
            role="img"
            aria-label={verified ? "Verified advisor" : "Connected from your contacts"}
            className={cn(badgeClassName, "pointer-events-auto")}
          >
            {glyph}
          </span>
        )}
      </TooltipTrigger>
      {/* Opens below the icon, so it never covers the row above it; Radix still
          flips it up when the icon sits at the very bottom of the screen. The
          advisor badge is self-explanatory, so its tooltip is only its name. */}
      <TooltipContent
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        className="max-w-[min(14rem,calc(100vw_-_1.5rem))] text-left"
      >
        <span className="block font-semibold">{label}</span>
        {verified ? null : <span className="mt-0.5 block">{description}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

export function ConnectionStatusBadges({ riaVerified, fromContacts }: {
  riaVerified?: boolean;
  fromContacts?: boolean;
}) {
  if (!riaVerified && !fromContacts) return null;

  return (
    <TooltipProvider>
      <span className="inline-flex shrink-0 items-center gap-0.5">
        {riaVerified ? <ConnectionStatusBadge verified /> : null}
        {fromContacts ? <ConnectionStatusBadge /> : null}
      </span>
    </TooltipProvider>
  );
}
