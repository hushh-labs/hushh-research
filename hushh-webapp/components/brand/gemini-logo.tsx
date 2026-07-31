import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * Gemini's four-point brand mark. Keep this isolated as a brand asset: it is
 * not an app accent or a replacement for Hussh iconography.
 */
export function GeminiLogo({
  className,
  title = "Gemini",
}: {
  className?: string;
  title?: string;
}) {
  const gradientId = useId();

  return (
    <svg
      aria-label={title}
      role="img"
      viewBox="0 0 48 48"
      className={cn("h-6 w-6 shrink-0", className)}
    >
      <title>{title}</title>
      <defs>
        <linearGradient id={gradientId} x1="6" y1="5" x2="42" y2="43" gradientUnits="userSpaceOnUse">
          <stop stopColor="#EA4335" />
          <stop offset="0.28" stopColor="#FBBC05" />
          <stop offset="0.5" stopColor="#34A853" />
          <stop offset="0.74" stopColor="#4285F4" />
          <stop offset="1" stopColor="#A142F4" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M24 0c0 13.255-10.745 24-24 24 13.255 0 24 10.745 24 24 0-13.255 10.745-24 24-24C34.745 24 24 13.255 24 0Z"
      />
    </svg>
  );
}
