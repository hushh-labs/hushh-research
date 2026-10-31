import { Skeleton } from "@/components/ui/skeleton";

/** Quiet initial placeholders; existing snapshots remain in place on refresh. */
export function CalendarLoading({ label, rows = 3 }: { label: string; rows?: number }) {
  return <div role="status" aria-label={label} className="space-y-3">
    {Array.from({ length: rows }, (_, index) => <div key={index} aria-hidden="true" className="space-y-3 rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4">
      <Skeleton className="h-5 w-2/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/4 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-1/2 motion-reduce:animate-none" />
    </div>)}
  </div>;
}
