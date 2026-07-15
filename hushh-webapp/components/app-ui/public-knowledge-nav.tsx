"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

const ITEMS = [
  {
    label: "Research",
    href: ROUTES.RESEARCH,
    active: (pathname: string) =>
      pathname === ROUTES.RESEARCH ||
      pathname.startsWith(`${ROUTES.RESEARCH}/`),
  },
  {
    label: "Blog",
    href: ROUTES.BLOG,
    active: (pathname: string) =>
      pathname === ROUTES.BLOG || pathname.startsWith(`${ROUTES.BLOG}/`),
  },
] as const;

/** Shared, quiet navigation for the two public knowledge surfaces. */
export function PublicKnowledgeNav() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Public knowledge"
      className="grid grid-cols-2 border-b border-border/60"
    >
      {ITEMS.map((item) => {
        const active = item.active(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex min-h-11 items-center justify-center px-4 text-sm font-semibold transition-colors",
              active
                ? "text-foreground after:absolute after:inset-x-4 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[color:var(--app-accent)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
