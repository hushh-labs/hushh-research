export default function Loading() {
  return (
    <div className="min-h-screen bg-surface">
      {/* ─── Header Skeleton ─────────────────────────────────────────── */}
      <header className="border-b border-border-subtle bg-surface-raised/80 backdrop-blur-md sticky top-0 z-50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-surface-overlay animate-pulse" />
              <div className="space-y-1.5">
                <div className="h-4 w-24 rounded bg-surface-overlay animate-pulse" />
                <div className="h-2.5 w-32 rounded bg-surface-overlay animate-pulse" />
              </div>
            </div>
            <div className="h-8 w-32 rounded-full bg-surface-overlay animate-pulse" />
          </div>
        </div>
      </header>

      {/* ─── Main ───────────────────────────────────────────────────── */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-10">
        {/* Hero Trust Score Skeleton */}
        <section className="rounded-2xl border border-border-subtle bg-surface-raised p-8 sm:p-12">
          <div className="flex flex-col items-center justify-center gap-8">
            {/* Large Ring Skeleton */}
            <div className="h-32 w-32 rounded-full bg-surface-overlay animate-pulse" />
            {/* Text Below Ring */}
            <div className="text-center space-y-2">
              <div className="h-4 w-24 rounded bg-surface-overlay animate-pulse mx-auto" />
              <div className="h-5 w-40 rounded bg-surface-overlay animate-pulse mx-auto" />
            </div>
            {/* Email Section */}
            <div className="text-center space-y-2 w-full">
              <div className="h-4 w-24 rounded bg-surface-overlay animate-pulse mx-auto" />
              <div className="h-5 w-48 rounded bg-surface-overlay animate-pulse mx-auto" />
            </div>
          </div>
        </section>

        {/* Connected Services Skeleton (3-column Grid) */}
        <section className="space-y-5">
          <div className="space-y-2">
            <div className="h-5 w-32 rounded bg-surface-overlay animate-pulse" />
            <div className="h-4 w-48 rounded bg-surface-overlay animate-pulse" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-border-subtle bg-surface-raised p-5 space-y-4 animate-pulse"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3 w-full">
                    <div className="h-10 w-10 rounded-lg bg-surface-overlay animate-pulse" />
                    <div className="h-5 w-32 rounded bg-surface-overlay animate-pulse" />
                  </div>
                </div>
                <div className="h-6 w-20 rounded-full bg-surface-overlay animate-pulse" />
              </div>
            ))}
          </div>
        </section>

        {/* Permissions + Logs (2-column Grid) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
          {/* Permissions Skeleton */}
          <section className="space-y-5">
            <div className="space-y-2">
              <div className="h-5 w-24 rounded bg-surface-overlay animate-pulse" />
              <div className="h-4 w-48 rounded bg-surface-overlay animate-pulse" />
            </div>
            <div className="space-y-4">
              {[...Array(2)].map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-border-subtle bg-surface-raised overflow-hidden animate-pulse"
                >
                  <div className="h-12 bg-surface-overlay/50" />
                  <div className="divide-y divide-border-subtle">
                    {[...Array(2)].map((_, j) => (
                      <div key={j} className="h-16 bg-surface-raised" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Audit Log Skeleton */}
          <section className="space-y-5">
            <div className="space-y-2">
              <div className="h-5 w-32 rounded bg-surface-overlay animate-pulse" />
              <div className="h-4 w-48 rounded bg-surface-overlay animate-pulse" />
            </div>
            <div className="rounded-xl border border-border-subtle bg-surface-raised overflow-hidden">
              {/* Desktop Table Skeleton */}
              <div className="hidden md:block">
                <div className="h-12 bg-surface-overlay/50 animate-pulse" />
                <div className="divide-y divide-border-subtle">
                  {[...Array(4)].map((_, i) => (
                    <div
                      key={i}
                      className="h-14 bg-surface-raised animate-pulse"
                    />
                  ))}
                </div>
              </div>
              {/* Mobile Cards Skeleton */}
              <div className="md:hidden divide-y divide-border-subtle">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="px-4 py-4 space-y-2.5 animate-pulse">
                    <div className="h-4 w-20 rounded bg-surface-overlay" />
                    <div className="h-3.5 w-32 rounded bg-surface-overlay" />
                    <div className="h-3 w-24 rounded bg-surface-overlay" />
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* ─── Footer Skeleton ─────────────────────────────────────────── */}
      <footer className="border-t border-border-subtle py-6 text-center">
        <div className="h-3 w-48 rounded bg-surface-overlay animate-pulse mx-auto" />
      </footer>
    </div>
  );
}
