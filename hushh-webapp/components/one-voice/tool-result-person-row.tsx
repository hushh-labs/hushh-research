"use client";

import { AvatarBubble } from "@/lib/morphy-ux/ui/surface-primitives";
import { initialsFor } from "./entity-card";

export function PersonRow({
  userId,
  personRef,
  name,
  photoUrl,
  detail,
}: {
  userId?: string | null;
  personRef?: string | null;
  name: string;
  photoUrl: string | null;
  detail?: string | null;
}) {
  return (
    <li className="flex min-h-9 items-center gap-2.5">
      <AvatarBubble userId={userId} personRef={personRef}
        initials={initialsFor(name)}
        size={28}
        imageUrl={photoUrl}
      />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--app-label)]">
        {name}
      </span>
      {detail ? (
        <span className="shrink-0 text-[12px] text-[color:var(--app-secondary-label)]">
          {detail}
        </span>
      ) : null}
    </li>
  );
}
