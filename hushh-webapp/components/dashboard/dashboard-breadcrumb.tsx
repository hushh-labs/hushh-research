// components/dashboard/dashboard-breadcrumb.tsx

"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Home } from "lucide-react";
import { Icon } from "@/lib/morphy-ux/ui";

const pathNameMap: Record<string, string> = {
  kai: "Kai",
  dashboard: "Dashboard",
  fashion: "Fashion",
  transactions: "Transactions",
  travel: "Travel",
  social: "Social Media",
  fitness: "Fitness",
  setup: "Setup",
  agent: "AI Agent",
};

export function DashboardBreadcrumb() {
  const pathname = usePathname();

  if (!pathname) return null;

  const segments = pathname.split("/").filter(Boolean);

  // Always show at least Dashboard
  if (segments.length === 0) return null;

  // If on root kai, just show Kai
  if (segments.length === 1 && segments[0] === "kai") {
    return (
      <Breadcrumb>
        <BreadcrumbList className="flex items-center">
          <BreadcrumbItem>
            <BreadcrumbPage className="flex items-center gap-1">
              <Icon icon={Home} size="sm" />
              Kai
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  return (
    <Breadcrumb>
      <BreadcrumbList className="flex items-center">
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href="/kai" className="flex items-center gap-1">
              <Icon icon={Home} size="sm" />
              Kai
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>

        {segments.slice(1).map((segment, index) => {
          const isLast = index === segments.length - 2;
          const href = `/${segments.slice(0, index + 2).join("/")}`;
          const label =
            pathNameMap[segment] ||
            segment.charAt(0).toUpperCase() + segment.slice(1);

          return (
            <Fragment key={segment}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={href}>{label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
