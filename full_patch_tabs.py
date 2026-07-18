content = """\"use client\";

import { useCallback, useEffect, useMemo, useRef, useState } from \"react\";
import { usePathname, useRouter } from \"next/navigation\";

import { useKaiBottomChromeVisibility } from \"@/lib/navigation/kai-bottom-chrome-visibility\";
import { activeKaiRouteTabFromPath, KAI_ROUTE_TABS } from \"@/lib/navigation/kai-route-tabs\";
import { useKaiSession } from \"@/lib/stores/kai-session-store\";
import { ROUTES } from \"@/lib/navigation/routes\";
import { cn } from \"@/lib/utils\";
import { scrollAppToTop } from \"@/lib/navigation/use-scroll-reset\";
import { morphyToast as toast } from \"@/lib/morphy-ux/morphy\";
import { APP_SHELL_FRAME_CLASSNAME, APP_SHELL_FRAME_STYLE } from \"@/components/app-ui/app-page-shell\";
import { SegmentedPill } from \"@/lib/morphy-ux/ui/segmented-tabs\";

interface DashboardRouteTabsProps {
  embedded?: boolean;
}

export function DashboardRouteTabs({ embedded = false }: DashboardRouteTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const hideTabsForPath = pathname.startsWith(ROUTES.ONE_SETUP) || pathname.startsWith(ROUTES.KAI_IMPORT);
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
      if (busyOperations[\"portfolio_save\"]) {
        toast.info(\"Saving to vault. Please wait until encryption completes.\");
        return;
      }
      const target = KAI_ROUTE_TABS.find((tab) => tab.id === nextTab);
      if (!target || target.id === activeTab) return;
      scrollAppToTop(\"auto\");
      router.push(target.href);
    },
    [activeTab, busyOperations, router]
  );

  if (!mounted || hideTabsForPath) {
    return null;
  }

  const options = KAI_ROUTE_TABS.map(t => ({
    value: t.id,
    label: t.label,
  }));

  const tabsBody = (
    <div className=\"w-full px-3 py-2\">
      <SegmentedPill
        size=\"compact\"
        layout=\"stacked\"
        hitArea=\"segment\"
        value={activeTab}
        options={options}
        onValueChange={(val) => handleTabChange(val)}
        ariaLabel=\"Workspace navigation\"
        className=\"w-full bg-white/40 dark:bg-black/20 backdrop-blur-md rounded-full border border-border/60 drop-shadow-sm\"
      />
    </div>
  );

  if (embedded) {
    return (
      <div
        className={cn(
          \"relative flex w-full justify-center transform-gpu will-change-transform\",
          hideRouteTabs ? \"pointer-events-none opacity-0\" : \"pointer-events-auto opacity-100\"
        )}
        style={{
          transform: `translate3d(0, calc(${-100 * hideRouteTabsProgress}% - ${6 * hideRouteTabsProgress}px), 0)`,
          opacity: Math.max(0, 1 - hideRouteTabsProgress),
        }}
      >
        <div
          ref={tabsRootRef}
          data-tour-id=\"kai-route-tabs\"
          className=\"pointer-events-auto w-full max-w-[460px] overflow-hidden\"
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
        \"relative flex w-full justify-center transform-gpu will-change-transform z-10\",
        hideRouteTabs ? \"pointer-events-none opacity-0\" : \"pointer-events-auto opacity-100\"
      )}
      style={{
        ...APP_SHELL_FRAME_STYLE,
        transform: `translate3d(0, calc(${-100 * hideRouteTabsProgress}% - ${6 * hideRouteTabsProgress}px), 0)`,
        opacity: Math.max(0, 1 - hideRouteTabsProgress),
      }}
    >
      <div
        ref={tabsRootRef}
        data-tour-id=\"kai-route-tabs\"
        className=\"pointer-events-auto w-full max-w-[460px] overflow-hidden\"
      >
        {tabsBody}
      </div>
    </div>
  );
}
"""
with open('hushh-webapp/components/kai/layout/dashboard-route-tabs.tsx', 'w') as f:
    f.write(content)
