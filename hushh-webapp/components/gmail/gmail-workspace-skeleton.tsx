import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Gmail's token-free first paint. The capability boundary owns the actual
 * workspace mount; this only gives an authenticated person immediate shell
 * geometry while the memory-only vault owner token is established.
 */
export function GmailWorkspaceSkeleton() {
  return (
    <AppPageShell
      as="div"
      width="reading"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      aria-busy="true"
      aria-label="Checking your Gmail status"
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="Gmail"
          description="Checking your Gmail status"
          actions={<Skeleton className="h-10 w-36" />}
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack compact>
          <SurfaceInset className="space-y-3 border border-accent-border bg-accent-surface px-4 py-4 sm:px-5 sm:py-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Gmail
            </p>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Checking your Gmail status
            </h2>
            <p className="text-sm text-muted-foreground">
              Your inbox and receipts will appear here as they are ready.
            </p>
            <div className="space-y-2 pt-1" aria-hidden="true">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-full max-w-md" />
            </div>
          </SurfaceInset>

          <SurfaceInset className="space-y-3 px-4 py-4 sm:px-5 sm:py-5">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-full max-w-lg" />
            <Skeleton className="h-11 w-full sm:w-64" />
          </SurfaceInset>

          <SurfaceInset className="space-y-3 px-4 py-4 sm:px-5 sm:py-5">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-8 w-20" />
            </div>
            {Array.from({ length: 4 }, (_, index) => (
              <div className="flex items-center justify-between gap-4" key={index}>
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
                <Skeleton className="h-8 w-14 shrink-0" />
              </div>
            ))}
          </SurfaceInset>
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
