"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";

import { TopShellTabs } from "@/components/app-ui/top-shell-tabs";
import {
  resolveRiaRouteTabSet,
  type TopShellTabSet,
} from "@/lib/navigation/top-shell-tabs";
import { cn } from "@/lib/utils";

export function RiaRouteSelector({ className }: { className?: string }) {
  const pathname = usePathname();
  const tabSet = useMemo<TopShellTabSet | null>(
    () => resolveRiaRouteTabSet(pathname || "/ria/profile"),
    [pathname],
  );

  if (!tabSet) return null;

  return (
    <div data-testid="ria-route-selector" className={cn("w-full", className)}>
      <TopShellTabs tabSet={tabSet} />
    </div>
  );
}
