"use client";

import { useState } from "react";
import { BadgeCheck, ContactsBookIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function ConnectionStatusBadge({ verified, className, iconClassName }: {
  verified?: boolean;
  className?: string;
  iconClassName?: string;
}) {
  const label = verified ? "Verified Advisor" : "Via contacts";
  const Icon = verified ? BadgeCheck : ContactsBookIcon;
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn("inline-grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring", className)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          <Icon aria-hidden="true" className={cn("size-4", verified && "text-[color:var(--app-success,#16a34a)]", iconClassName)} />
        </button>
      </TooltipTrigger>
      <TooltipContent sideOffset={4} collisionPadding={12}>{label}</TooltipContent>
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
