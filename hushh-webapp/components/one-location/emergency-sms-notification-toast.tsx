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
      className="flex w-full flex-col gap-3 text-left text-white"
    >
      <div className="flex items-start gap-3">
        <span className="relative mt-0.5 grid size-10 shrink-0 place-items-center rounded-full bg-white/15 ring-1 ring-inset ring-white/30">
          <span className="absolute inset-0 animate-ping rounded-full bg-white/25 motion-reduce:animate-none" />
          <Icon
            icon={Siren}
            size="md"
            className="relative text-white"
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white">
            Emergency SMS
          </p>
          <p className="mt-0.5 text-[15px] font-bold leading-5 text-white">
            {title}
          </p>
          <p className="mt-1 line-clamp-3 text-[13px] leading-5 text-white">
            {description}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="press-scale flex min-h-11 w-full items-center justify-between rounded-[var(--app-radius-pill)] border border-white bg-white px-4 text-sm font-semibold text-red-700 shadow-sm transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-red-600"
      >
        <span className="flex items-center gap-2">
          <Icon icon={MapPin} size="sm" aria-hidden="true" />
          View live location
        </span>
        <Icon icon={ChevronRight} size="sm" aria-hidden="true" />
      </button>
    </div>
  );
}
