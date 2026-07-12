"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

const TABS = [
  {
    id: "overview",
    label: "Research",
    href: ROUTES.RESEARCH,
    active: "bg-sky-500/[0.12] text-sky-700 dark:text-sky-300",
  },
  {
    id: "protocol",
    label: "PCHP Specification",
    href: ROUTES.RESEARCH_PROTOCOL,
    active: "bg-violet-500/[0.12] text-violet-700 dark:text-violet-300",
  },
  {
    id: "blog",
    label: "Blog",
    href: ROUTES.BLOG,
    active: "bg-fuchsia-500/[0.12] text-fuchsia-700 dark:text-fuchsia-300",
  },
] as const;

export function ResearchSubNav() {
  const pathname = usePathname();
  const activeId =
    pathname === ROUTES.RESEARCH
      ? "overview"
      : pathname?.startsWith(ROUTES.RESEARCH_PROTOCOL)
        ? "protocol"
        : pathname?.startsWith(ROUTES.BLOG)
          ? "blog"
          : "overview";

  return (
    <nav
      aria-label="Research sections"
      className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-3"
    >
      {TABS.map((tab) => {
        const active = tab.id === activeId;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              active
                ? tab.active
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
            aria-current={active ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
