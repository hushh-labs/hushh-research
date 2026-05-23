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
import { Home, ShoppingBag, CreditCard, Plane, Users, Dumbbell, Settings, Bot } from "lucide-react";
import { Icon } from "@/lib/morphy-ux/ui";

// Mapping segments to readable labels and icons
const pathConfig: Record<string, { label: string; icon?: any }> = {
  kai: { label: "Kai", icon: Home },
  dashboard: { label: "Dashboard" },
  fashion: { label: "Fashion", icon: ShoppingBag },
  transactions: { label: "Transactions", icon: CreditCard },
  travel: { label: "Travel", icon: Plane },
  social: { label: "Social Media", icon: Users },
  fitness: { label: "Fitness", icon: Dumbbell },
  setup: { label: "Setup", icon: Settings },
  agent: { label: "AI Agent", icon: Bot },
};

const formatLabel = (segment: string) => {
  return segment.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
};

export function DashboardBreadcrumb() {
  const pathname = usePathname();

  if (!pathname || pathname === "/") return null;

  const segments = pathname.split("/").filter(Boolean);

  return (
    <Breadcrumb className="hidden md:flex">
      <BreadcrumbList>
        {segments.map((segment, index) => {
          const href = `/${segments.slice(0, index + 1).join("/")}`;
          const isLast = index === segments.length - 1;
          const config = pathConfig[segment];
          const label = config?.label || formatLabel(segment);
          const SegmentIcon = config?.icon;

          return (
            <Fragment key={href}>
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage className="flex items-center gap-1.5 font-medium">
                    {SegmentIcon && <Icon icon={SegmentIcon} size="sm" />}
                    {label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={href} className="flex items-center gap-1.5 transition-colors hover:text-foreground">
                      {SegmentIcon && <Icon icon={SegmentIcon} size="sm" />}
                      {label}
                    </Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}