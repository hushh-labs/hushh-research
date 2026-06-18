"use client";

import * as React from "react";
import { Clock3 } from "lucide-react";
import { cn } from "@/lib/utils";

type StaleCacheTimestampProps = {
  updatedAt?: string | number | Date | null;
  stale?: boolean;
  label?: string;
};

const getRelativeTime = (date: Date) => {
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (diffInSeconds < 60) return "Updated just now";
  if (diffInSeconds < 3600) return formatter.format(-Math.floor(diffInSeconds / 60), "minute");
  if (diffInSeconds < 86400) return formatter.format(-Math.floor(diffInSeconds / 3600), "hour");
  return formatter.format(-Math.floor(diffInSeconds / 86400), "day");
};

export function StaleCacheTimestamp({ updatedAt, stale = false, label }: StaleCacheTimestampProps) {
  const [mounted, setMounted] = React.useState(false);
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    setMounted(true);
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  if (!mounted) return null;

  const date = updatedAt ? new Date(updatedAt) : null;
  const text = date && !isNaN(date.getTime()) ? getRelativeTime(date) : (label || "Using saved data");

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        stale
          ? "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-border/60 bg-background/70 text-muted-foreground"
      )}
      suppressHydrationWarning
    >
      <Clock3 className="h-3.5 w-3.5" />
      <span>{stale ? `${text} · stale` : text}</span>
    </div>
  );
}