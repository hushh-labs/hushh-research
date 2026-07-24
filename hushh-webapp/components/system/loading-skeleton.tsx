type LoadingSkeletonProps = {
  className?: string;
};

export function LoadingSkeleton({ className = "" }: LoadingSkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-2xl bg-muted ${className}`}
    />
  );
}

export function LoadingSkeletonCard() {
  return (
    <div className="rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)]/50 bg-[color:var(--app-card-surface-compact)]/55 px-4 py-3">
      <div className="flex items-start gap-3">
        <LoadingSkeleton className="h-10 w-10 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2">
          <LoadingSkeleton className="h-4 w-2/3" />
          <LoadingSkeleton className="h-3 w-1/2" />
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <LoadingSkeleton className="h-3 w-full" />
        <LoadingSkeleton className="h-3 w-5/6" />
      </div>
    </div>
  );
}

export function LoadingSkeletonList({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, index) => (
        <LoadingSkeletonCard key={index} />
      ))}
    </div>
  );
}