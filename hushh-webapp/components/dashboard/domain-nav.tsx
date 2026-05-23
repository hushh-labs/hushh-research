"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { TrendingUp, Plus, Loader2 } from "lucide-react";
import { Icon } from "@/lib/morphy-ux/ui";

// Mocking the interface for future integration
interface Domain {
  name: string;
  href: string;
  icon: any;
  status: "active" | "inactive";
  color: string;
}

const domains: Domain[] = [
  { name: "Kai", href: "/kai/portfolio", icon: TrendingUp, status: "active", color: "text-primary" },
];

export function DomainNav() {
  const pathname = usePathname();
  const isLoading = false; // Replace with actual loading state from service

  return (
    <nav className="space-y-1.5 px-2">
      {isLoading ? (
        <div className="flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground animate-pulse">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading domains...
        </div>
      ) : (
        <>
          {domains.map((domain) => {
            const isActive = pathname === domain.href || pathname?.startsWith(`${domain.href}/`);
            
            return (
              <Link
                key={domain.name}
                href={domain.href}
                className={cn(
                  "group relative flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200",
                  isActive
                    ? "bg-accent text-accent-foreground shadow-sm"
                    : "hover:bg-accent/50 text-muted-foreground hover:text-foreground"
                )}
              >
                <div className="flex items-center gap-3">
                  <Icon icon={domain.icon} size="md" className={cn(domain.color, isActive && "opacity-100")} />
                  <span>{domain.name}</span>
                </div>
                {isActive && (
                  <span className="absolute right-2 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </Link>
            );
          })}
          
          <button className="flex w-full items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-primary transition-colors border border-dashed border-transparent hover:border-border">
            <Plus className="h-4 w-4" />
            <span>Add Domain</span>
          </button>
        </>
      )}
    </nav>
  );
}