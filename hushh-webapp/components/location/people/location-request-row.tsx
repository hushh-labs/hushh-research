"use client";

import type { ReactNode } from "react";
import { connectionAvatarInitials as personInitials } from "@/components/connections/connection-person-avatar";
import { MUTED_TEXT, SUBCARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import { AvatarBubble } from "@/lib/morphy-ux/ui/surface-primitives";
import { cn } from "@/lib/utils";

export function RequestRow({
  userId,
  name,
  photoUrl,
  detail,
  actions,
  testId,
}: {
  userId?: string;
  name: string;
  photoUrl?: string | null;
  detail: string;
  actions: ReactNode;
  testId: string;
}) {
  return (
    <div
      className={cn(
        SUBCARD_SURFACE,
        "flex min-h-[58px] flex-wrap items-center gap-3 px-3.5 py-2.5",
      )}
      data-testid={testId}
    >
      <AvatarBubble userId={userId}
        initials={personInitials(name)}
        imageUrl={photoUrl}
        size={36}
      />
      <div className="min-w-0 flex-1">
        <p className="ui-text-row-label truncate">{name}</p>
        <p className={cn(MUTED_TEXT, "truncate")}>{detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}
