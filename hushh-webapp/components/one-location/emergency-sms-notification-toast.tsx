"use client";

import { ChevronRight, MapPin, Siren } from "lucide-react";

import { Icon } from "@/lib/morphy-ux/ui";

export function EmergencySmsNotificationToast({
  title,
  description,
  onOpen,
}: {
  title: string;
  description: string;
  onOpen: () => void;
}) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-one-location-emergency-sms-alert
      className="flex w-full flex-col gap-3 text-left text-destructive-foreground"
    >
      <div className="flex items-start gap-3">
        <span className="relative mt-0.5 grid size-10 shrink-0 place-items-center rounded-full bg-background/20">
          <span className="absolute inset-0 animate-ping rounded-full bg-background/20 motion-reduce:animate-none" />
          <Icon
            icon={Siren}
            size="md"
            className="relative text-destructive-foreground"
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-destructive-foreground/80">
            Emergency SMS
          </p>
          <p className="mt-0.5 text-[15px] font-bold leading-5">{title}</p>
          <p className="mt-1 line-clamp-3 text-[13px] leading-5 text-destructive-foreground/90">
            {description}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="press-scale flex min-h-11 w-full items-center justify-between rounded-[var(--app-radius-pill)] bg-background px-4 text-sm font-semibold text-foreground"
      >
        <span className="flex items-center gap-2">
          <Icon icon={MapPin} size="sm" aria-hidden="true" />
          Open live location
        </span>
        <Icon icon={ChevronRight} size="sm" aria-hidden="true" />
      </button>
    </div>
  );
}
