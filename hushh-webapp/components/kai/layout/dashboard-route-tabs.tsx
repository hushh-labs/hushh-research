"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import {
  activeKaiRouteTabFromPath,
  KAI_ROUTE_TABS,
} from "@/lib/navigation/kai-route-tabs";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import { scrollAppToTop } from "@/lib/navigation/use-scroll-reset";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import {
  APP_SHELL_FRAME_CLASSNAME,
  APP_SHELL_FRAME_STYLE,
} from "@/components/app-ui/app-page-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DashboardRouteTabsProps {
  embedded?: boolean;
}

export function DashboardRouteTabs({ embedded = false }: DashboardRouteTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const hideTabsForPath =
    pathname.startsWith(ROUTES.ONE_ONBOARDING) || pathname.startsWith(ROUTES.KAI_IMPORT);
  const [mounted, setMounted] = useState(false);
  const tabsRootRef = useRef<HTMLDivElement | null>(null);
  const { hidden: hideRouteTabs, progress: hideRouteTabsProgress } = useKaiBottomChromeVisibility(!hideTabsForPath);
  const busyOperations = useKaiSession((s) => s.busyOperations);

  const activeTab = useMemo(
    () => activeKaiRouteTabFromPath(pathname || ROUTES.KAI_HOME),
    [pathname]
  );

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const handleTabChange = useCallback(
    (nextTab: string) => {
      if (busyOperations["portfolio_save"]) {
        toast.info("Saving to vault. Please wait until encryption completes.");
        return;
      }
      const target = KAI_ROUTE_TABS.find((tab) => tab.id === nextTab);
      if (!target || target.id === activeTab) return;
      scrollAppToTop("auto");
      router.push(target.href);
    },
    [activeTab, busyOperations, router]
  );

  if (!mounted || hideTabsForPath) {
    return null;
  }

  const activeTabIndex = Math.max(
    0,
    KAI_ROUTE_TABS.findIndex((tab) => tab.id === activeTab)
  );
  const maxTabIndex = KAI_ROUTE_TABS.length - 1;
  const indicatorIndex = Math.max(
    0,
    Math.min(maxTabIndex, activeTabIndex)
  );

  const tabsBody = (
    <>
      <div className="sm:hidden">
        <Select value={activeTab} onValueChange={handleTabChange}>
          <SelectTrigger
            size="sm"
            className="h-9 w-full rounded-full border-border/70 bg-background/80 px-3 text-sm font-semibold"
            aria-label="Kai section"
          >
            <SelectValue placeholder="Kai section" />
          </SelectTrigger>
          <SelectContent align="center">
            {KAI_ROUTE_TABS.map((tab) => (
              <SelectItem key={tab.id} value={tab.id}>
                {tab.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div role="tablist" className="relative hidden grid-cols-4 items-center border-b border-border/70 px-1 sm:grid">
        {KAI_ROUTE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            onClick={() => handleTabChange(tab.id)}
            aria-selected={tab.id === activeTab}
            className={cn(
              "relative z-[1] h-8 text-sm font-semibold transition-colors duration-200",
              tab.id === activeTab
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
            aria-current={tab.id === activeTab ? "page" : undefined}
          >
            {tab.label}
          </button>
        ))}
        <span
          data-testid="kai-route-tabs-indicator"
          aria-hidden
          className={cn(
            "pointer-events-none absolute bottom-0 left-0 h-[3px] rounded-full bg-linear-to-r from-sky-500 via-primary to-sky-400 shadow-[0_0_0_1px_rgba(56,189,248,0.35),0_0_22px_rgba(56,189,248,0.62)]",
            "transition-transform duration-250 ease-out"
          )}
          style={{
            width: `calc(100% / ${KAI_ROUTE_TABS.length})`,
            transform: `translate3d(${indicatorIndex * 100}%, 0, 0)`,
          }}
        />
      </div>
    </>
  );

  if (embedded) {
    return (
      <div
        className={cn(
          "relative flex w-full justify-center transform-gpu will-change-transform",
          hideRouteTabs ? "pointer-events-none opacity-0" : "pointer-events-auto opacity-100"
        )}
        style={{
          transform: `translate3d(0, calc(${-100 * hideRouteTabsProgress}% - ${6 * hideRouteTabsProgress}px), 0)`,
          opacity: Math.max(0, 1 - hideRouteTabsProgress),
        }}
      >
        <div
          ref={tabsRootRef}
          data-tour-id="kai-route-tabs"
          className="pointer-events-auto w-full max-w-[460px] overflow-hidden"
        >
          {tabsBody}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        APP_SHELL_FRAME_CLASSNAME,
        "relative flex w-full justify-center transform-gpu will-change-transform",
        hideRouteTabs ? "pointer-events-none opacity-0" : "pointer-events-auto opacity-100"
      )}
      style={{
        ...APP_SHELL_FRAME_STYLE,
        transform: `translate3d(0, calc(${-100 * hideRouteTabsProgress}% - ${6 * hideRouteTabsProgress}px), 0)`,
        opacity: Math.max(0, 1 - hideRouteTabsProgress),
      }}
    >
      <div
        ref={tabsRootRef}
        data-tour-id="kai-route-tabs"
        className="pointer-events-auto w-full max-w-[460px] overflow-hidden"
      >
        {tabsBody}
      </div>
    </div>
  );
}
