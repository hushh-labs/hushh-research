"use client";

import { useEffect } from "react";
import { Home, RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/lib/morphy-ux/button";
import { Card } from "@/lib/morphy-ux/card";
import { BrandMark, Icon } from "@/lib/morphy-ux/ui";
import { ROUTES } from "@/lib/navigation/routes";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

/**
 * App Router error boundary for every route under app/.
 *
 * Without this file an unhandled render error falls through to Next's default
 * error screen, which is jarring and off-brand at the exact moment a person is
 * least confident. This keeps the recovery moment in One's voice — calm,
 * non-blaming, with a way forward — and mirrors app/not-found.tsx so the two
 * "something is off" states feel like the same product.
 *
 * Deliberately makes no absolute claims about data ("nothing was shared"):
 * this boundary catches render failures and cannot know what happened upstream,
 * and a consent-first product must not offer a reassurance it can't guarantee.
 */
export default function AppErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced for diagnostics; the digest is the id support can trace.
    console.error("[app/error] Unhandled route error:", error);
  }, [error]);

  const handleGoHome = () => {
    requestInternalAppNavigation({
      href: ROUTES.HOME,
      replace: true,
      scroll: false,
    });
  };

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center px-6 pb-[var(--app-screen-footer-pad)]">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <BrandMark size="sm" unframed className="text-[54px]" />
        <Card preset="default" effect="glass" glassAccent="soft" className="w-full">
          <div className="flex flex-col items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color:var(--app-card-surface-compact)] text-muted-foreground">
              <TriangleAlert className="h-7 w-7" aria-hidden="true" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-lg font-semibold tracking-normal">
                Something went wrong
              </h1>
              <p className="text-sm leading-relaxed text-muted-foreground">
                That one&apos;s on us, not you. Try again, or head back to One.
              </p>
            </div>
            <div className="flex gap-3 pt-1">
              <Button variant="muted" effect="glass" size="sm" onClick={reset}>
                <Icon icon={RefreshCw} size="sm" className="mr-1.5" />
                Try again
              </Button>
              <Button size="sm" onClick={handleGoHome}>
                <Icon icon={Home} size="sm" className="mr-1.5" />
                Go home
              </Button>
            </div>
            {error.digest ? (
              <p className="pt-1 text-[11px] text-muted-foreground/70">
                Reference: {error.digest}
              </p>
            ) : null}
          </div>
        </Card>
      </div>
    </main>
  );
}
