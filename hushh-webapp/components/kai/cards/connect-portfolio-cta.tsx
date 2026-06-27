"use client";

import { ArrowRight, Wallet } from "lucide-react";
import Link from "next/link";

// Import the actual type definition for the accent
import { SurfaceCard, SurfaceCardContent, type SurfaceAccent } from "@/components/app-ui/surfaces";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/navigation/routes";

interface ConnectPortfolioCtaProps {
  className?: string;
  // Use the imported type to ensure type safety
  accent?: SurfaceAccent;
}

export function ConnectPortfolioCta({ className, accent = "emerald" }: ConnectPortfolioCtaProps) {
  return (
    <SurfaceCard accent={accent} className={cn("overflow-hidden", className)}>
      <SurfaceCardContent className="space-y-6 p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
          <Icon icon={Wallet} size="lg" />
        </div>

        <div className="space-y-2">
          <h3 className="text-lg font-semibold tracking-tight">
            See insights tailored to your portfolio
          </h3>
          <p className="text-sm text-muted-foreground">
            Unlock personalized analysis and real-time alerts.
          </p>
        </div>

        <div className="space-y-2">
          <Button
            size="lg"
            fullWidth
            asChild
            showRipple
            aria-label="Connect your financial portfolio"
          >
            <Link href={ROUTES.KAI_IMPORT}>
              Connect Portfolio
              <Icon icon={ArrowRight} size="md" className="ml-2" />
            </Link>
          </Button>

          <Button
            variant="link"
            effect="fill"
            size="sm"
            fullWidth
            asChild
            showRipple={false}
          >
            <Link href={ROUTES.KAI_HOME}>Or continue exploring</Link>
          </Button>
        </div>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}