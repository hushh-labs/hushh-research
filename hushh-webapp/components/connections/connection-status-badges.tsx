"use client";

import { useState } from "react";
import { BadgeCheck, ContactsBookIcon } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

function ConnectionStatusBadge({ verified }: { verified?: boolean }) {
  const label = verified ? "Verified Advisor" : "Via contacts";
  const Icon = verified ? BadgeCheck : ContactsBookIcon;
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          <Icon aria-hidden="true" className={verified ? "size-4 text-[color:var(--app-success)]" : "size-4"} />
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
