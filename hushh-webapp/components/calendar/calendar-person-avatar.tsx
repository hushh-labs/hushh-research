"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { openPersonProfilePreview } from "@/lib/connections/person-profile-preview";
import { cn } from "@/lib/utils";
import styles from "./calendar-person-avatar.module.css";

/**
 * One profile shape and fallback across Calendar. Surfaces that pass `size` get the shared scale;
 * surfaces that omit it keep supplying their own geometry through CSS (`className`).
 */
export function CalendarPersonAvatar({ name, photoUrl, userId, personRef, className, fallbackClassName, fallbackText, tone, size, source }: {
  userId?: string | null;
  personRef?: string | null;
  name: string;
  photoUrl: string | null;
  className?: string;
  fallbackClassName?: string;
  fallbackText?: string;
  tone?: number;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  source?: "hussh";
}) {
  const initial = fallbackText || name.trim().slice(0, 1).toUpperCase() || "?";
  const sized = size !== undefined;
  const fallbackClass = sized ? cn(styles.fallback, fallbackClassName) : fallbackClassName;
  const interactive = Boolean(userId || personRef);
  const Root = interactive ? "button" : "span";
  return <Avatar asChild key={`${name}:${photoUrl || "initials"}`} className={sized ? cn(styles.avatar, className) : className} data-size={size} data-tone={tone} data-photo-url={photoUrl || undefined} data-photo-source={photoUrl && source ? source : undefined} title={photoUrl && source ? "HUSSH profile photo" : undefined}>
    <Root type={interactive ? "button" : undefined} aria-hidden={interactive ? undefined : true} aria-label={interactive ? `View ${name}'s profile` : undefined} onClick={interactive ? event => { event.preventDefault(); event.stopPropagation(); openPersonProfilePreview({ userId, personRef }, event.currentTarget); } : undefined}>
    {photoUrl ? <>
      <span data-slot="avatar-fallback" className={cn(sized ? styles.fallback : "rounded-full bg-muted text-muted-foreground text-sm", fallbackClassName, "absolute inset-0 flex items-center justify-center")}>{initial}</span>
      <AvatarImage src={photoUrl} alt="" referrerPolicy="no-referrer" className="relative z-[1]" />
    </> : <AvatarFallback className={fallbackClass}>{initial}</AvatarFallback>}
    </Root>
  </Avatar>;
}
