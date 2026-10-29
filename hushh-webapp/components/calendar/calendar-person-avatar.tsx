"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

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
  const initial = fallbackText || name.trim().slice(0, 1).toUpperCase() || "?";
  return <Avatar key={`${name}:${photoUrl || "initials"}`} aria-hidden className={className} data-tone={tone} data-photo-url={photoUrl || undefined} data-photo-source={photoUrl && source ? source : undefined} title={photoUrl && source ? "HUSSH profile photo" : undefined}>
    {photoUrl ? <>
      <span data-slot="avatar-fallback" className={cn("absolute inset-0 flex items-center justify-center rounded-full bg-muted text-muted-foreground text-sm", fallbackClassName)}>{initial}</span>
      <AvatarImage src={photoUrl} alt="" referrerPolicy="no-referrer" className="relative z-[1]" />
    </> : <AvatarFallback className={fallbackClassName}>{initial}</AvatarFallback>}
  </Avatar>;
}
