"use client";

import { GlobalErrorFallback } from "@/components/system/global-error-fallback";

export default function GlobalError({
  error,
 _reset,
}: {
  error: Error;
  _reset: () => void;
}) {
  return (
    <GlobalErrorFallback
      title="Application error"
      description={
        error?.message ||
        "An unexpected application error occurred."
      }
    />
  );
}