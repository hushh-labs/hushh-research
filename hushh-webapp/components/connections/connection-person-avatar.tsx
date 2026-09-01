"use client";

import { BadgeCheck } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export function connectionAvatarInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0] ?? "";
  if (parts.length === 1) return (first.slice(0, 2) || "?").toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase() || "?";
}

/**
 * Canonical avatar for connection rows.
 *
 * The photo says who the person is; the verified badge says what status the row
 * carries. Keep them together so Connect and Location invite sheets cannot
 * drift into different person identities.
 */
export function ConnectionPersonAvatar({
  photoUrl,
  label,
  verified = false,
  className,
}: {
  photoUrl?: string | null;
  label: string;
  verified?: boolean;
  className?: string;
}) {
  return (
    <Avatar
      className={cn("relative h-[34px] w-[34px] shrink-0", className)}
      data-photo-url={photoUrl ?? undefined}
    >
      {photoUrl ? <AvatarImage src={photoUrl} alt="" /> : null}
      <AvatarFallback className="text-xs">
        {connectionAvatarInitials(label)}
      </AvatarFallback>
      {verified ? (
        <span
          className="absolute -right-0.5 -bottom-0.5 z-10 inline-flex size-[15px] items-center justify-center rounded-full bg-background"
          aria-label="Verified advisor"
        >
          <BadgeCheck
            className="size-[13px] text-[color:var(--app-success,#16a34a)]"
            aria-hidden="true"
          />
        </span>
      ) : null}
    </Avatar>
  );
}
