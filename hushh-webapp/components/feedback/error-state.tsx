"use client";

import { AlertTriangle } from "lucide-react";

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
}

export default function ErrorState({
  title = "Something went wrong",
  description = "An unexpected error occurred.",
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-red-200 bg-red-50 p-8 text-center">
      <AlertTriangle
        className="mb-4 text-red-500"
        size={48}
      />

      <h2 className="text-xl font-semibold text-red-700">
        {title}
      </h2>

      <p className="mt-2 max-w-md text-sm text-red-600">
        {description}
      </p>

      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-6 rounded-xl bg-red-600 px-5 py-2 text-white transition hover:bg-red-700"
        >
          Retry
        </button>
      )}
    </div>
  );
}