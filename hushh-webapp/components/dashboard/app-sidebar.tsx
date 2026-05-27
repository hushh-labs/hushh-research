// hushh-webapp/components/dashboard/app-sidebar.tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { LayoutDashboard, ShieldAlert, User, Cpu } from "lucide-react";

const navigationItems = [
  { title: "Dashboard", href: "/kai/dashboard", icon: LayoutDashboard },
  { title: "Kai Management", href: "/kai", icon: Cpu },
  { title: "Consent Center", href: "/consents", icon: ShieldAlert },
  { title: "Profile Panel", href: "/profile", icon: User },
];

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();

  return (
    <Sidebar variant="sidebar" collapsible="icon" {...props}>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Application Core</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigationItems.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <SidebarMenuItem key={item.title}>
                    {/* FIXED: Implemented asChild pattern to cleanly hand off navigation targets to next/link */}
                    <SidebarMenuButton
                      asChild
                      tooltip={item.title}
                      className={cn(
                        "transition-colors duration-200",
                        isActive && "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      )}
                    >
                      <Link href={item.href}>
                        <item.icon className="h-4 w-4 shrink-0" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}