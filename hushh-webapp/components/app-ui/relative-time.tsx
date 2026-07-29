"use client";

import * as React from "react";
import { cn } from "@/lib/morphy-ux/cn";

export interface RelativeTimeProps extends React.TimeHTMLAttributes<HTMLTimeElement> {
  date: Date | string | number;
  refreshIntervalMs?: number;
}

/**
 * Hydration-Safe Semantic Relative Time
 * Solves Next.js timestamp hydration mismatches by mounting safely on the client.
 * Features auto-refreshing intervals and strict HTML5 <time> semantics for A11y.
 */
export function RelativeTime({
  date,
  refreshIntervalMs = 60000,
  className,
  ...props
}: RelativeTimeProps) {
  const [isMounted, setIsMounted] = React.useState(false);
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    setIsMounted(true);
    // Auto-update the relative string without requiring a full page refresh
    const interval = setInterval(() => setTick((t) => t + 1), refreshIntervalMs);
    return () => clearInterval(interval);
  }, [refreshIntervalMs]);

  const parsedDate = new Date(date);
  const isValid = !isNaN(parsedDate.getTime());

  if (!isValid) {
    return <span className={cn("text-muted-foreground", className)}>Invalid date</span>;
  }

  const absoluteIso = parsedDate.toISOString();
  const localString = parsedDate.toLocaleString();

  const getRelativeString = () => {
    const diffInSeconds = Math.floor((new Date().getTime() - parsedDate.getTime()) / 1000);
    
    if (diffInSeconds < 60) return "Just now";
    
    const diffInMins = Math.floor(diffInSeconds / 60);
    if (diffInMins < 60) return `${diffInMins} min${diffInMins > 1 ? "s" : ""} ago`;
    
    const diffInHours = Math.floor(diffInMins / 60);
    if (diffInHours < 24) return `${diffInHours} hr${diffInHours > 1 ? "s" : ""} ago`;
    
    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays < 30) return `${diffInDays} day${diffInDays > 1 ? "s" : ""} ago`;

    // Graceful fallback for older dates
    return parsedDate.toLocaleDateString();
  };

  return (
    <time
      dateTime={absoluteIso}
      title={localString}
      className={cn("tabular-nums text-muted-foreground", className)}
      {...props}
    >
      {/* Renders a placeholder on the server to prevent React Hydration crashes */}
      {isMounted ? getRelativeString() : "..."}
    </time>
  );
}