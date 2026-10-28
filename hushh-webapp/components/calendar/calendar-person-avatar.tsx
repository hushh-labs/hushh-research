"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

/** Calendar's existing avatar geometry is supplied by each surface's CSS. */
export function CalendarPersonAvatar({ name, photoUrl, className, fallbackClassName, fallbackText, tone, source }: {
  name: string;
  photoUrl: string | null;
  className?: string;
  fallbackClassName?: string;
  fallbackText?: string;
  tone?: number;
  source?: "hussh";
}) {
  return <Avatar aria-hidden className={className} data-tone={tone} data-photo-url={photoUrl || undefined} data-photo-source={photoUrl && source ? source : undefined} title={photoUrl && source ? "HUSSH profile photo" : undefined}>
    {photoUrl ? <AvatarImage src={photoUrl} alt="" referrerPolicy="no-referrer" /> : null}
    <AvatarFallback className={fallbackClassName}>{fallbackText || name.trim().slice(0, 1).toUpperCase() || "?"}</AvatarFallback>
  </Avatar>;
}
