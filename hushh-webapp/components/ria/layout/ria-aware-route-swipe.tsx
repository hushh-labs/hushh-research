"use client";

import { useMemo, type ReactNode } from "react";

import { TopShellRouteSwipe } from "@/components/app-ui/top-shell-route-swipe";
import {
  applyRiaTabOptions,
  type TopShellTabSet,
} from "@/lib/navigation/top-shell-tabs";
import { useRiaPicksOffered } from "@/lib/ria/use-ria-picks-offered";

/**
 * The shell resolves its swipe tab set above PersonaProvider, where it cannot
 * know whether Picks is offered. This applies the RIA tab strip's rule inside
 * the provider, so an advisor who is not verified cannot swipe into Picks.
 */
export function RiaAwareTopShellRouteSwipe({
  children,
  tabSet,
}: {
  children: ReactNode;
  tabSet: TopShellTabSet | null;
}) {
  const includePicks = useRiaPicksOffered();
  const offeredTabSet = useMemo(
    () => (tabSet ? applyRiaTabOptions(tabSet, { includePicks }) : null),
    [includePicks, tabSet],
  );

  return <TopShellRouteSwipe tabSet={offeredTabSet}>{children}</TopShellRouteSwipe>;
}
