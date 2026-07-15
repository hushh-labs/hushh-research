"use client";

import { useEffect } from "react";

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

function safeErrorClass(error: GlobalErrorProps["error"]): string {
  const name = String(error?.name || "Error").replace(/[^A-Za-z0-9_-]/g, "");
  return name.slice(0, 48) || "Error";
}

/**
 * Last-resort App Router boundary.
 *
 * Next's built-in production boundary hides the only useful native diagnostic.
 * Publish only the error class and opaque digest; messages can contain request
 * details and must never cross the native log boundary.
 */
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  const errorClass = safeErrorClass(error);
  const digest = String(error?.digest || "").slice(0, 96);

  useEffect(() => {
    console.error("[GlobalErrorBoundary]", { errorClass, digest });
  }, [digest, errorClass]);

  return (
    <html lang="en">
      <body>
        <main
          data-native-global-error={errorClass}
          className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground"
        >
          <div className="w-full max-w-sm text-center">
            <h1 className="text-2xl font-semibold">This page couldn&apos;t load</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Retry the page, or go back to continue.
            </p>
            <div className="mt-5 flex justify-center gap-3">
              <button
                type="button"
                className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background"
                onClick={reset}
              >
                Retry
              </button>
              <button
                type="button"
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium"
                onClick={() => window.history.back()}
              >
                Back
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
