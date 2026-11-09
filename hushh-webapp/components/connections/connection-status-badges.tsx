"use client";

import { useId } from "react";
import { BadgeCheck, ContactsBookIcon, X } from "@/components/icons";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const BADGES = {
  ria: {
    label: "RIA verified",
    description: "This person is verified as a registered investment adviser (RIA).",
    icon: BadgeCheck,
    iconClassName: "text-[color:var(--app-success,#16a34a)]",
  },
  contacts: {
    label: "From Contacts",
    description: "This connection was matched through your synced contacts.",
    icon: ContactsBookIcon,
    iconClassName: "",
  },
} as const;

function ConnectionStatusBadge({ kind }: { kind: keyof typeof BADGES }) {
  const { label, description, icon: Icon, iconClassName } = BADGES[kind];
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Popover>
      <PopoverTrigger
        type="button"
        className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-start text-xs font-medium text-foreground outline-none hover:bg-foreground/10 active:bg-foreground/15 focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-foreground/10"
      >
        <Icon aria-hidden="true" className={`size-4 shrink-0 ${iconClassName}`} />
        {label}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={12}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-64 max-w-[var(--radix-popover-content-available-width)] rounded-xl p-3 motion-reduce:animate-none"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-sm">
            <p id={titleId} className="font-semibold">{label}</p>
            <p id={descriptionId} className="mt-1 text-muted-foreground">{description}</p>
          </div>
          <PopoverClose
            aria-label={`Close ${label} details`}
            className="-mr-1 -mt-1 grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-4" />
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ConnectionStatusBadges({ riaVerified, fromContacts }: {
  riaVerified?: boolean;
  fromContacts?: boolean;
}) {
  if (!riaVerified && !fromContacts) return null;

  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1">
      {riaVerified ? <ConnectionStatusBadge kind="ria" /> : null}
      {fromContacts ? <ConnectionStatusBadge kind="contacts" /> : null}
    </div>
  );
}
