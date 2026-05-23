import * as React from "react";
import Link from "next/link";
import { SidebarMenuButton } from "@/components/ui/sidebar"; // Adjust path if necessary

export function AppSidebar({ items }: { items: { url: string; title: string; icon: any }[] }) {
  return (
    <div className="sidebar">
      {items.map((item) => (
        <SidebarMenuButton key={item.title} asChild>
          <Link href={item.url}>
            <item.icon />
            <span>{item.title}</span>
          </Link>
        </SidebarMenuButton>
      ))}
    </div>
  );
}