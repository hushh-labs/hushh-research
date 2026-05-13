"use client";

import { LogIn, ShieldAlert } from "lucide-react";
import Link from "next/link";

import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";

type SessionExpiryRecoveryProps = {
  title?: string;
  description?: string;
};

export function SessionExpiryRecovery({
  title = "Session expired",
  description = "Your session may have expired. Sign in again to continue securely.",
}: SessionExpiryRecoveryProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-[var(--app-card-radius-compact)] border border-amber-500/20 bg-amber-500/10 p-4"
    >
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-amber-500/15 p-2">
          <ShieldAlert className="h-5 w-5 text-amber-700 dark:text-amber-300" />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="text-sm font-semibold text-foreground">{title}</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>

          <Button asChild variant="none" effect="fade" size="sm">
            <Link href={ROUTES.LOGIN}>
              <LogIn className="mr-2 h-4 w-4" />
              Sign in again
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
