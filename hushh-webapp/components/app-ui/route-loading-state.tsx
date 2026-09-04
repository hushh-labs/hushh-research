import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { InlineLoadingState } from "@/components/app-ui/inline-loading-state";
import { cn } from "@/lib/utils";

export type RouteLoadingSurface = "app" | "onboarding" | "ambient";

type RouteLoadingStateProps = {
  /** Plain-language status announced while a cold route segment resolves. */
  label?: string;
  /** The route family determines the shell geometry; it never exposes route content. */
  surface?: RouteLoadingSurface;
  className?: string;
};

function RouteLoadingIndicator({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      data-route-loading-content="true"
      className="w-full"
    >
      <InlineLoadingState label={label} className="px-0 py-0" />
    </div>
  );
}

/**
 * Cold route fallback with the same shell geometry as the route family it
 * represents. It intentionally renders one labeled progress indicator:
 * authenticated context, vault-backed content, and stale cache values remain
 * owned by their existing route resources and guards.
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
        <RouteLoadingIndicator label={label} />
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
        <RouteLoadingIndicator label={label} />
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
      <RouteLoadingIndicator label={label} />
    </AppPageShell>
  );
}
