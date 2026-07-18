"use client";

import { AlertCircle, RotateCcw } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4 sm:px-6 lg:px-8">
      {/* ─── Error Card ──────────────────────────────────────────────── */}
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-border-subtle bg-surface-raised p-8 space-y-6">
          {/* Icon */}
          <div className="flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-red-dim border border-accent-red/20">
              <AlertCircle className="h-8 w-8 text-accent-red" />
            </div>
          </div>

          {/* Content */}
          <div className="text-center space-y-3">
            <h1 className="text-2xl font-bold text-text-primary">
              Something Went Wrong
            </h1>
            <p className="text-sm text-text-secondary">
              We encountered an issue while loading your privacy trust dashboard.
              This may be due to a network error or API unavailability.
            </p>
          </div>

          {/* Error Details (Development Only) */}
          {process.env.NODE_ENV === "development" && error.message && (
            <div className="rounded-lg bg-surface-overlay border border-border-subtle p-3">
              <p className="text-xs text-text-muted font-mono truncate">
                {error.message}
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-col gap-3 pt-2">
            <button
              onClick={() => reset()}
              className="group relative flex items-center justify-center gap-2 rounded-lg bg-accent-green hover:bg-accent-green/90 px-4 py-3 text-sm font-medium text-white transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-green focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <RotateCcw className="h-4 w-4 transition-transform group-hover:rotate-180" />
              Try Again
            </button>
            <a
              href="/"
              className="flex items-center justify-center rounded-lg border border-border-subtle bg-surface-overlay hover:bg-surface-raised px-4 py-3 text-sm font-medium text-text-primary transition-colors duration-200"
            >
              Go to Dashboard
            </a>
          </div>

          {/* Support Text */}
          <p className="text-xs text-text-muted text-center">
            If the problem persists, please check your internet connection or
            contact support.
          </p>
        </div>
      </div>
    </div>
  );
}
