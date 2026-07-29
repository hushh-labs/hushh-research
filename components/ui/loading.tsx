"use client";

export function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-6">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-black"></div>
    </div>
  );
}
