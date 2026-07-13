import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type RouteLoadingSurface = "app" | "onboarding" | "ambient";

type RouteLoadingStateProps = {
  /** Plain-language status announced while a cold route segment resolves. */
  label?: string;
  /** The route family determines the shell geometry; it never exposes route content. */
  surface?: RouteLoadingSurface;
  className?: string;
};

function LoadingSkeleton({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      data-route-loading-content="true"
      role="status"
      className="w-full space-y-6"
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-3">
        <Skeleton className="h-3 w-20 rounded-full" />
        <Skeleton className="h-8 w-48 max-w-[72%] rounded-xl" />
        <Skeleton className="h-4 w-80 max-w-full rounded-md" />
      </div>
      <div
        aria-hidden="true"
        className="overflow-hidden rounded-[var(--app-card-radius-feature)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]"
      >
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className={cn(
              "flex min-h-16 items-center gap-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]",
              index > 0 && "border-t border-[color:var(--foundation-hairline)]",
            )}
          >
            <Skeleton className="h-10 w-10 shrink-0 rounded-2xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-32 max-w-[60%] rounded-md" />
              <Skeleton className="h-3 w-52 max-w-[85%] rounded-md" />
            </div>
            <Skeleton className="h-4 w-16 shrink-0 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Cold route fallback with the same shell geometry as the route family it
 * represents. It intentionally renders only neutral placeholders: authenticated
 * context, vault-backed content, and stale cache values remain owned by their
 * existing route resources and guards.
 */
export function RouteLoadingState({
  label = "Loading page…",
  surface = "app",
  className,
}: RouteLoadingStateProps) {
  if (surface === "onboarding") {
    return (
      <FullscreenFlowShell
        as="main"
        width="reading"
        data-route-loading-surface={surface}
        className={cn("justify-start pt-[clamp(3rem,12vh,8rem)]", className)}
      >
        <LoadingSkeleton label={label} />
      </FullscreenFlowShell>
    );
  }

  if (surface === "ambient") {
    return (
      <main
        data-route-loading-surface={surface}
        className={cn(
          "mx-auto flex min-h-[100dvh] w-full max-w-[var(--app-shell-reading)] items-center px-[var(--page-inline-gutter-standard)]",
          className,
        )}
      >
        <LoadingSkeleton label={label} />
      </main>
    );
  }

  return (
    <AppPageShell
      as="main"
      width="standard"
      data-route-loading-surface={surface}
      className={cn(
        "min-h-[min(44rem,100dvh)] py-[var(--page-top-start)]",
        className,
      )}
    >
      <LoadingSkeleton label={label} />
    </AppPageShell>
  );
}
