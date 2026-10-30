"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";

import { TopShellTabs } from "@/components/app-ui/top-shell-tabs";
import {
  resolveRiaRouteTabSet,
  type TopShellTabSet,
} from "@/lib/navigation/top-shell-tabs";
import { usePersonaState } from "@/lib/persona/persona-context";
import { isRiaVerified, riaVerificationStatusOf } from "@/lib/ria/ria-verification";
import { cn } from "@/lib/utils";

export function RiaRouteSelector({ className }: { className?: string }) {
  const pathname = usePathname();
  const { riaOnboardingStatus } = usePersonaState();
  // Picks is for verified advisors only. Until verification is known the tab
  // stays hidden rather than being offered and then taken away.
  const includePicks = isRiaVerified(
    riaVerificationStatusOf(riaOnboardingStatus),
  );
  const tabSet = useMemo<TopShellTabSet | null>(
    () =>
      resolveRiaRouteTabSet(pathname || "/ria/profile", { includePicks }),
    [includePicks, pathname],
  );

  if (!tabSet) return null;

  return (
    <div data-testid="ria-route-selector" className={cn("w-full", className)}>
      <TopShellTabs tabSet={tabSet} />
    </div>
  );
}
