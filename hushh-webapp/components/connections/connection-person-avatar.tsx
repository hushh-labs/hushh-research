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
/**
 * Which row rhythm this avatar is sitting in.
 *
 * `SettingsRow` draws its inset separator from a fixed offset per density --
 * 58px on `compact`, 62px on `comfortable` -- and those numbers are the row
 * padding plus the LEADING VISUAL plus the gap. A compact row therefore expects
 * a 28px leading visual, which is what its own icon well is (`h-7 w-7`).
 *
 * This avatar was 34px at every call site, including inside compact rows. So on
 * Connect's Connections list the hairlines started at 58px while the text
 * started at 62px, and every separator sat 4px shy of the column it was meant
 * to align with -- while the Circles tab beside it, whose rows use the 28px
 * icon well, lined up exactly. Same screen, same primitive, two rhythms.
 *
 * Reported as "circle and Connections dono ka thoda alag alag feel ho rha hai".
 */
export type ConnectionPersonAvatarSize = "compact" | "comfortable" | "profile";

const AVATAR_SIZE_CLASSNAME: Record<ConnectionPersonAvatarSize, string> = {
  compact: "h-7 w-7",
  comfortable: "h-[34px] w-[34px]",
  profile: "h-16 w-16",
};

/** The verified badge scales with the face, or it swallows a 28px one. */
const AVATAR_BADGE_CLASSNAME: Record<ConnectionPersonAvatarSize, string> = {
  compact: "size-[13px]",
  comfortable: "size-[15px]",
  profile: "size-[19px]",
};

const AVATAR_BADGE_GLYPH_CLASSNAME: Record<ConnectionPersonAvatarSize, string> =
  {
    compact: "size-[11px]",
    comfortable: "size-[13px]",
    profile: "size-[17px]",
  };

const AVATAR_FALLBACK_CLASSNAME: Record<ConnectionPersonAvatarSize, string> = {
  compact: "text-xs",
  comfortable: "text-xs",
  profile: "text-3xl",
};

export function ConnectionPersonAvatar({
  photoUrl,
  label,
  verified = false,
  size = "comfortable",
  className,
}: {
  photoUrl?: string | null;
  label: string;
  verified?: boolean;
  /**
   * Match the row it sits in. `compact` inside a `SettingsRow density="compact"`,
   * so the separator inset the row already draws lands on the text.
   */
  size?: ConnectionPersonAvatarSize;
  className?: string;
}) {
  return (
    <Avatar
      className={cn(
        "relative shrink-0",
        AVATAR_SIZE_CLASSNAME[size],
        className,
      )}
      data-photo-url={photoUrl ?? undefined}
      data-avatar-size={size}
    >
      {photoUrl ? <AvatarImage src={photoUrl} alt="" /> : null}
      <AvatarFallback className={AVATAR_FALLBACK_CLASSNAME[size]}>
        {connectionAvatarInitials(label)}
      </AvatarFallback>
      {verified ? (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 z-10 inline-flex items-center justify-center rounded-full bg-background",
            AVATAR_BADGE_CLASSNAME[size],
          )}
          aria-label="Verified advisor"
        >
          <BadgeCheck
            className={cn(
              "text-[color:var(--app-success,#16a34a)]",
              AVATAR_BADGE_GLYPH_CLASSNAME[size],
            )}
            aria-hidden="true"
          />
        </span>
      ) : null}
    </Avatar>
  );
}
