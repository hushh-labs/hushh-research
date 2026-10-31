"use client";

import { BadgeCheck } from "@/components/icons";
import { ContactSourceBadge } from "./contact-source-badge";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { openPersonProfilePreview, type PersonProfilePreviewIdentity } from "@/lib/connections/person-profile-preview";

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
export type ConnectionPersonAvatarSize =
  "compact" | "comfortable" | "list" | "profile";

const AVATAR_SIZE_CLASSNAME: Record<ConnectionPersonAvatarSize, string> = {
  compact: "h-7 w-7",
  comfortable: "h-[34px] w-[34px]",
  list: "h-10 w-10",
  profile: "h-16 w-16",
};

/** The verified badge scales with the face, or it swallows a 28px one. */
const AVATAR_BADGE_CLASSNAME: Record<ConnectionPersonAvatarSize, string> = {
  compact: "size-[13px]",
  comfortable: "size-[15px]",
  list: "size-[15px]",
  profile: "size-[19px]",
};

const AVATAR_BADGE_GLYPH_CLASSNAME: Record<ConnectionPersonAvatarSize, string> =
  {
    compact: "size-[11px]",
    comfortable: "size-[13px]",
    list: "size-[13px]",
    profile: "size-[17px]",
  };

const AVATAR_FALLBACK_CLASSNAME: Record<ConnectionPersonAvatarSize, string> = {
  compact: "text-xs",
  comfortable: "text-xs",
  list: "text-sm",
  profile: "text-3xl",
};

export function ConnectionPersonAvatar({
  photoUrl,
  label,
  verified = false,
  fromContacts = false,
  size = "comfortable",
  className,
  fallbackClassName,
  testId,
  personRef,
  userId,
  minimumHitArea = false,
}: PersonProfilePreviewIdentity & {
  photoUrl?: string | null;
  label: string;
  verified?: boolean;
  fromContacts?: boolean;
  /**
   * Match the row it sits in. `compact` inside a `SettingsRow density="compact"`,
   * so the separator inset the row already draws lands on the text.
   */
  size?: ConnectionPersonAvatarSize;
  className?: string;
  fallbackClassName?: string;
  testId?: string;
  minimumHitArea?: boolean;
}) {
  const interactive = Boolean(personRef?.trim() || userId?.trim());
  const content = <>

      {photoUrl?.trim() ? (
        <AvatarImage
          key={photoUrl}
          src={photoUrl.trim()}
          alt=""
          referrerPolicy="no-referrer"
          className="rounded-full"
        />
      ) : null}
      <AvatarFallback
        aria-hidden="true"
        className={cn(AVATAR_FALLBACK_CLASSNAME[size], fallbackClassName)}
      >
        {connectionAvatarInitials(label)}
      </AvatarFallback>
      {verified ? (
        <span
          className={cn(
            "absolute -right-0.5 z-10 inline-flex items-center justify-center rounded-full bg-background",
            fromContacts ? "-top-0.5" : "-bottom-0.5",
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
      {fromContacts ? (
        <ContactSourceBadge className="absolute -bottom-0.5 -right-0.5 z-10 size-3 rounded-sm bg-background ring-2 ring-background" />
      ) : null}
  </>;
  const expandedHitArea = interactive && minimumHitArea;
  const avatar = (
    <Avatar
      asChild={interactive && !expandedHitArea}
      key={photoUrl?.trim() || "initials"}
      className={cn(
        "relative shrink-0 overflow-visible",
        AVATAR_SIZE_CLASSNAME[size],
        className,
        interactive && !expandedHitArea && "cursor-pointer p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      data-photo-url={photoUrl ?? undefined}
      data-avatar-size={size}
      data-testid={testId}
    >
      {interactive && !expandedHitArea ? <button type="button" aria-label={`View ${label}'s profile`} onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        openPersonProfilePreview({ personRef, userId }, event.currentTarget);
      }}>{content}</button> : content}
    </Avatar>
  );
  if (!expandedHitArea) return avatar;
  return <span className="relative inline-flex shrink-0">{avatar}<button type="button" aria-label={`View ${label}'s profile`}
    className="absolute left-1/2 top-1/2 z-10 size-11 -translate-x-1/2 -translate-y-1/2 cursor-pointer appearance-none rounded-full border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onClick={event => { event.preventDefault(); event.stopPropagation(); openPersonProfilePreview({ personRef, userId }, event.currentTarget); }} /></span>;
}
