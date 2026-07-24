"use client";

import { AlertTriangle, RefreshCcw } from "lucide-react";

import { Button } from "@/lib/morphy-ux/button";

type GlobalErrorFallbackProps = {
  title?: string;
  description?: string;
};

export function GlobalErrorFallback({
  title = "Something went wrong",
  description = "We hit an unexpected issue. Try again or reload the page.",
}: GlobalErrorFallbackProps) {
  return (
    <div className="flex min-h-[320px] w-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-md rounded-[28px] border border-red-500/15 bg-card p-6 shadow-[var(--app-card-shadow-feature)]">
        <div className="flex items-start gap-4">
          <div className="rounded-2xl bg-red-500/10 p-3">
            <AlertTriangle className="h-6 w-6 text-red-600" />
          </div>

          <div className="space-y-2">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {title}
            </h2>

            <p className="text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button
            variant="blue-gradient"
            effect="fill"
            size="sm"
            onClick={() => window.location.reload()}
          >
            <RefreshCcw className="mr-2 h-4 w-4" />
            Reload page
          </Button>

          <Button
            variant="none"
            effect="fade"
            size="sm"
            onClick={() => window.history.back()}
          >
            Go back
          </Button>
        </div>
      </div>
    </div>
  );
}