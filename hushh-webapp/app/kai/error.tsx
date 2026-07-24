"use client";

import { useEffect } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { Card } from "@/lib/morphy-ux/card";
import { AlertTriangle } from "lucide-react";

/**
 * Kai route error boundary.
 *
 * Next.js file-system error boundary for /kai and all sub-routes.
 * Catches render errors and shows a Morphy-styled recovery UI
 * instead of the default Next.js white-screen error page.
 *
 * Pairs with the runtime RouteErrorBoundary in kai/layout.tsx:
 * - layout.tsx wraps children with a class-based boundary (runtime)
 * - this file.tsx is the Next.js segment-level boundary (framework)
 */
export default function KaiError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[KaiError] Uncaught error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6">
      <Card
        preset="default"
        effect="glass"
        glassAccent="soft"
        className="mx-auto w-full max-w-sm text-center"
      >
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500/12 to-orange-500/12 dark:from-red-400/16 dark:to-orange-400/16">
            <AlertTriangle className="h-7 w-7 text-red-500 dark:text-red-400" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight">
              Something went wrong
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              An unexpected error occurred. You can try again or return to the
              home screen.
            </p>
          </div>
          <div className="flex gap-3 pt-1">
            <Button
              variant="muted"
              effect="glass"
              size="sm"
              onClick={reset}
            >
              Try again
            </Button>
            <Button
              variant="blue-gradient"
              effect="fill"
              size="sm"
              onClick={() => {
                window.location.href = "/kai";
              }}
            >
              Go home
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
