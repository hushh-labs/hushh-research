"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export function RouteTransitionProgress() {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);

    const timeout = window.setTimeout(() => {
      setLoading(false);
    }, 450);

    return () => window.clearTimeout(timeout);
  }, [pathname]);

  if (!loading) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[9999] h-1 overflow-hidden"
    >
      <div className="route-transition-progress h-full w-full bg-foreground/80" />
    </div>
  );
}