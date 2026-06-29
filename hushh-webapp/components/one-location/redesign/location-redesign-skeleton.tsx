"use client";

/**
 * LocationRedesignSkeleton — loading placeholder for the redesigned One Location
 * hub. Mirrors the real hub layout (header, local tabs, privacy status, primary
 * actions, and stacked cards) so the loading → loaded transition has no layout
 * shift and stays visually consistent with the app's other skeletons.
 *
 * PRESENTATION ONLY. Uses the shared Skeleton primitive and the same app-card
 * surface tokens as the live screens.
 */

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CARD_SURFACE, SUBCARD_SURFACE } from "./tokens";

function CardSkeleton({
  rows = 1,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn(SUBCARD_SURFACE, "flex items-center gap-3 p-3.5", className)}>
      <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-2/5 rounded-md" />
        {rows > 0 ? <Skeleton className="h-3 w-3/5 rounded-md" /> : null}
      </div>
      <Skeleton className="h-7 w-16 shrink-0 rounded-full" />
    </div>
  );
}

function SectionCardSkeleton({
  title = true,
  children,
}: {
  title?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={cn(CARD_SURFACE, "space-y-3 p-4")}>
      {title ? <Skeleton className="h-5 w-32 rounded-md" /> : null}
      {children}
    </section>
  );
}

export function LocationRedesignSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading One Location" role="status">
      {/* Header: title + subtitle + refresh */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-7 w-44 rounded-lg" />
          <Skeleton className="h-4 w-28 rounded-md" />
        </div>
        <Skeleton className="h-9 w-20 shrink-0 rounded-full" />
      </div>

      {/* Local tabs (Now | People | Links | Inbox) */}
      <div className="grid w-full grid-cols-4 gap-1 rounded-full border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] p-1 shadow-[var(--app-card-shadow-standard)]">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton
            key={index}
            className={cn(
              "h-9 rounded-full",
              index === 0 ? "opacity-100" : "opacity-50",
            )}
          />
        ))}
      </div>

      {/* Privacy status card */}
      <section className={cn(CARD_SURFACE, "p-5")}>
        <div className="flex items-center gap-3">
          <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-40 rounded-md" />
            <Skeleton className="h-3.5 w-56 max-w-full rounded-md" />
          </div>
        </div>
      </section>

      {/* Primary actions */}
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-12 rounded-2xl" />
        <Skeleton className="h-12 rounded-2xl" />
      </div>

      {/* Active shares */}
      <SectionCardSkeleton>
        <CardSkeleton />
      </SectionCardSkeleton>

      {/* Device readiness */}
      <SectionCardSkeleton>
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-32 rounded-md" />
            <Skeleton className="h-3 w-48 max-w-full rounded-md" />
          </div>
        </div>
        <Skeleton className="h-10 w-full rounded-full" />
      </SectionCardSkeleton>

      {/* Quick paths */}
      <SectionCardSkeleton>
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className={cn(SUBCARD_SURFACE, "flex items-center gap-3 p-3.5")}
            >
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-24 rounded-md" />
                <Skeleton className="h-3 w-40 max-w-full rounded-md" />
              </div>
              <Skeleton className="h-4 w-4 shrink-0 rounded-md" />
            </div>
          ))}
        </div>
      </SectionCardSkeleton>
    </div>
  );
}
