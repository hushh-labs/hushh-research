"use client";

import * as React from "react";
import { LogIn, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";

type SessionExpiryRecoveryProps = {
  title?: string;
  description?: string;
};

export function SessionExpiryRecovery({
  title = "Session expired",
  description = "Your session has expired. Sign in again to continue securely.",
}: SessionExpiryRecoveryProps) {
  const pathname = usePathname();

  // Construct a redirect URL to send the user back to the current page after login
  const loginUrl = `${ROUTES.LOGIN}?callbackUrl=${encodeURIComponent(pathname)}`;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-[var(--app-card-radius-compact)] border border-amber-500/20 bg-amber-500/10 p-4"
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-full bg-amber-500/15 p-2">
          <ShieldAlert className="h-5 w-5 text-amber-700 dark:text-amber-300" />
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-sm font-semibold text-foreground">{title}</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
          </div>

          <Button asChild variant="none" effect="fade" size="sm" className="w-fit">
            <Link href={loginUrl}>
              <LogIn className="mr-2 h-4 w-4" />
              Sign in again
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}