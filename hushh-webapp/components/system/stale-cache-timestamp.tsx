"use client";

import { Clock3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type StaleCacheTimestampProps = {
  updatedAt?: string | number | Date | null;
  stale?: boolean;
  label?: string;
};

function formatRelativeTime(value: string | number | Date) {
  const timestamp = new Date(value).getTime();

  if (!Number.isFinite(timestamp)) {
    return "Update time unavailable";
  }

  const deltaMs = Date.now() - timestamp;
  const absMs = Math.abs(deltaMs);

  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (absMs < minuteMs) return "Updated just now";
  if (absMs < hourMs) {
    const minutes = Math.round(absMs / minuteMs);
    return `Updated ${minutes}m ago`;
  }
  if (absMs < dayMs) {
    const hours = Math.round(absMs / hourMs);
    return `Updated ${hours}h ago`;
  }

  const days = Math.round(absMs / dayMs);
  return `Updated ${days}d ago`;
}

export function StaleCacheTimestamp({
  updatedAt,
  stale = false,
  label,
}: StaleCacheTimestampProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 60 * 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const text = useMemo(() => {
    if (!updatedAt) return label || "Using saved data";
    return formatRelativeTime(updatedAt);
  }, [label, updatedAt]);

  return (
    <div
      className={
        stale
          ? "inline-flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
          : "inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-xs font-medium text-muted-foreground"
      }
    >
      <Clock3 className="h-3.5 w-3.5" />
      <span>{stale ? `${text} · stale` : text}</span>
    </div>
  );
}