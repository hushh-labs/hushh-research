import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Quiet icon well shared by Location's utility rows and onboarding choices. */
export function LocationUtilityIcon({
  children,
  size = "regular",
  className,
  testId,
}: {
  children: ReactNode;
  size?: "compact" | "regular";
  className?: string;
  testId?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-location-utility-icon=""
      data-testid={testId}
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-[color:var(--app-settings-icon-surface)] text-[color:var(--app-settings-icon-foreground)]",
        size === "compact"
          ? "h-7 w-7 rounded-[8px]"
          : "h-8 w-8 rounded-[9px]",
        className,
      )}
    >
      {children}
    </span>
  );
}
