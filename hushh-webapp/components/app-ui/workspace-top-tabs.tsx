"use client";

import { useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";

import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { resolveWorkspaceTopTabs } from "@/lib/navigation/workspace-top-tabs";
import { cn } from "@/lib/utils";

export function WorkspaceTopTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const tabSet = useMemo(() => resolveWorkspaceTopTabs(pathname), [pathname]);

  if (!tabSet) return null;

  return (
    <div
      data-slot="workspace-top-tabs"
      className="pointer-events-auto h-[var(--top-tabs-h)] min-w-0"
    >
      <div
        role="tablist"
        aria-label={`${tabSet.label} navigation`}
        className="scrollbar-none flex h-full min-w-0 items-end gap-1 overflow-x-auto px-0.5 [scrollbar-width:none]"
      >
        {tabSet.tabs.map((tab) => {
          const selected = tab.id === tabSet.activeId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-current={selected ? "page" : undefined}
              onClick={() => {
                if (!selected) router.push(tab.href);
              }}
              className={cn(
                "relative inline-flex h-8 shrink-0 items-center justify-center overflow-hidden rounded-full px-3 text-[13px] font-medium transition-colors [-webkit-tap-highlight-color:transparent] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                selected
                  ? "bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent-deep)] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-bright)]"
                  : "text-muted-foreground hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.07] dark:hover:text-foreground",
              )}
            >
              <span className="relative z-10">{tab.label}</span>
              <MaterialRipple variant="blue" effect="fade" className="z-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
