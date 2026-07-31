"use client";

import { usePathname } from "next/navigation";
import { Shield, TrendingUp, Home } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuBadge,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { Icon, SidebarMenuButton } from "@/lib/morphy-ux/ui";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { useConsentPendingSummaryCount } from "@/lib/consent/use-consent-pending-summary-count";
import { ROUTES } from "@/lib/navigation/routes";

const domains = [
  {
    name: "Kai",
    href: ROUTES.KAI_PORTFOLIO,
    icon: TrendingUp,
    status: "active",
  },
];

export function AppSidebar() {
  const pathname = usePathname();
  const pendingCount = useConsentPendingSummaryCount();

  return (
    <Sidebar>
      <SidebarHeader className="h-16 flex items-center justify-start border-b px-4">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🤫</span>
          <div>
            <h2 className="font-semibold">Hussh PDA</h2>
            <p className="text-xs text-muted-foreground">Personal Data Agent</p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* Dashboard Overview */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  href={ROUTES.KAI_HOME}
                  isActive={pathname === ROUTES.KAI_HOME || pathname === ROUTES.LEGACY_KAI_HOME}
                  size="lg"
                  className="md:h-12 md:text-base font-semibold"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Icon icon={Home} size="sm" aria-hidden="true" />
                  </div>
                  <span className="ml-2">Kai</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Data Domains */}
        <SidebarGroup>
          <SidebarGroupLabel>Data Domains</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {domains.map((domain) => {
                const isActive =
                  pathname === domain.href ||
                  pathname?.startsWith(domain.href + "/");
                const DomainIcon = domain.icon;

                return (
                  <SidebarMenuItem key={domain.href}>
                    <SidebarMenuButton href={domain.href} isActive={isActive}>
                      <Icon icon={DomainIcon} size="sm" aria-hidden="true" />
                      <span>{domain.name}</span>
                    </SidebarMenuButton>
                    {domain.status === "soon" && (
                      <SidebarMenuBadge>Soon</SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Security */}
        <SidebarGroup>
          <SidebarGroupLabel>Security</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  href={buildConsentCenterHref("pending")}
                  isActive={pathname === "/consents"}
                >
                  <Icon icon={Shield} size="sm" aria-hidden="true" />
                  <span>Consents</span>
                </SidebarMenuButton>
                {pendingCount > 0 && (
                  <SidebarMenuBadge className="bg-red-500 text-white">
                    {pendingCount}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
