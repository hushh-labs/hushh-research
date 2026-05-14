"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  ChevronRight, 
  Home, 
  Database, 
  ShieldCheck, 
  User,
  LayoutDashboard
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * RootLayout for hussh-webapp
 * Provides a persistent navigation shell and dynamic breadcrumbs
 * to handle deep nesting like /profile/my-data/gmail.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  // Efficiently parse breadcrumbs from the URL segments
  const breadcrumbs = useMemo(() => {
    const segments = pathname.split("/").filter((v) => v.length > 0);
    return segments.map((segment, index) => {
      const path = `/${segments.slice(0, index + 1).join("/")}`;
      return {
        // Formats segment: "my-data" -> "My Data"
        label: segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, " "),
        path,
        isLast: index === segments.length - 1,
      };
    });
  }, [pathname]);

  return (
    <div className="flex min-h-screen w-full flex-col bg-background">
      {/* 
          Sticky Navigation Header 
          Designed to be simple and efficient, reducing layout shifts.
      */}
      <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center gap-4 px-4">
          <div className="flex items-center gap-2">
            <Link 
              href="/" 
              className="flex items-center gap-2 font-semibold transition-colors hover:text-primary"
            >
              <div className="rounded-md bg-primary p-1">
                <LayoutDashboard className="h-4 w-4 text-primary-foreground" />
              </div>
              <span className="hidden md:inline-block">hussh-labs</span>
            </Link>
          </div>

          <nav className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
            <ChevronRight className="h-4 w-4 shrink-0" />
            <Link 
              href="/" 
              className="flex items-center gap-1 hover:text-foreground transition-colors"
            >
              <Home className="h-3.5 w-3.5" />
            </Link>

            {breadcrumbs.map((crumb) => (
              <React.Fragment key={crumb.path}>
                <ChevronRight className="h-4 w-4 shrink-0" />
                <Link
                  href={crumb.path}
                  className={cn(
                    "transition-colors hover:text-foreground",
                    crumb.isLast ? "pointer-events-none font-bold text-foreground" : ""
                  )}
                >
                  {crumb.label}
                </Link>
              </React.Fragment>
            ))}
          </nav>
        </div>
      </header>

      {/* 
          Main Content Shell 
          The padding-bottom ensures content isn't cut off by floating elements.
      */}
      <main className="flex-1 overflow-y-auto pb-10">
        {children}
      </main>

      {/* 
          Optional Bottom Nav for Mobile Efficiency 
          Targets high-usage areas in the hussh structure.
      */}
      <footer className="fixed bottom-0 z-40 w-full border-t bg-background md:hidden">
        <div className="grid h-16 grid-cols-4 items-center justify-items-center">
          <Link href="/kai/dashboard" className="flex flex-col items-center gap-1 text-[10px]">
            <LayoutDashboard className="h-5 w-5" />
            <span>Dashboard</span>
          </Link>
          <Link href="/profile/my-data" className="flex flex-col items-center gap-1 text-[10px]">
            <Database className="h-5 w-5" />
            <span>Data</span>
          </Link>
          <Link href="/profile/security" className="flex flex-col items-center gap-1 text-[10px]">
            <ShieldCheck className="h-5 w-5" />
            <span>Security</span>
          </Link>
          <Link href="/profile" className="flex flex-col items-center gap-1 text-[10px]">
            <User className="h-5 w-5" />
            <span>Profile</span>
          </Link>
        </div>
      </footer>
    </div>
  );
}