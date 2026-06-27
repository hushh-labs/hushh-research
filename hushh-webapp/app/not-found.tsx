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
    <main className="flex min-h-[100dvh] flex-col items-center justify-center px-6 pb-[var(--app-screen-footer-pad)] bg-background">
      <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center animate-in fade-in zoom-in duration-500">
        <BrandMark size="sm" />

        <Card preset="default" effect="glass" glassAccent="soft" className="w-full p-8 border-border/50">
          <div className="flex flex-col items-center gap-6">
            {/* Visual Icon Container */}
            <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-muted/50 text-muted-foreground ring-1 ring-border/50 shadow-inner">
              <SearchX className="h-10 w-10" aria-hidden="true" />
            </div>

            {/* Error Message */}
            <div className="space-y-2">
              <h1 className="text-xl font-bold tracking-tight" aria-live="polite">
                Page not found
              </h1>
              <p className="text-sm text-muted-foreground max-w-[240px] mx-auto leading-relaxed">
                The content you&apos;re looking for is unavailable or has been moved.
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-3 w-full">
              <Button
                type="button"
                variant="muted"
                effect="glass"
                size="default"
                className="flex-1"
                onClick={handleGoBack}
              >
                <Icon icon={ArrowLeft} size="sm" className="mr-2" />
                Back
              </Button>
              <Button
                type="button"
                variant="blue-gradient"
                effect="fill"
                size="default"
                className="flex-1"
                onClick={handleGoHome}
              >
                <Icon icon={Home} size="sm" className="mr-2" />
                Home
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}