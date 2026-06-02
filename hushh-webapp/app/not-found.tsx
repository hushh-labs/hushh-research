"use client";

import { ArrowLeft, Home, SearchX } from "lucide-react";

import { Button } from "@/lib/morphy-ux/button";
import { Card } from "@/lib/morphy-ux/card";
import { BrandMark, Icon } from "@/lib/morphy-ux/ui";
import { ROUTES } from "@/lib/navigation/routes";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

export default function AppNotFoundPage() {
  const handleGoBack = () => {
    window.history.back();
  };

  const handleGoHome = () => {
    requestInternalAppNavigation({
      href: ROUTES.HOME,
      replace: true,
      scroll: false,
    });
  };

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center px-6 pb-[var(--app-screen-footer-pad)]">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <BrandMark size="sm" />
        <Card preset="default" effect="glass" glassAccent="soft" className="w-full">
          <div className="flex flex-col items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color:var(--app-card-surface-compact)] text-muted-foreground">
              <SearchX className="h-7 w-7" aria-hidden="true" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-lg font-semibold tracking-normal">
                Page not found
              </h1>
              <p className="text-sm leading-relaxed text-muted-foreground">
                The page you&apos;re looking for doesn&apos;t exist or may have
                been moved.
              </p>
            </div>
            <div className="flex gap-3 pt-1">
              <Button variant="muted" effect="glass" size="sm" onClick={handleGoBack}>
                <Icon icon={ArrowLeft} size="sm" className="mr-1.5" />
                Go back
              </Button>
              <Button variant="blue-gradient" effect="fill" size="sm" onClick={handleGoHome}>
                <Icon icon={Home} size="sm" className="mr-1.5" />
                Go home
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
