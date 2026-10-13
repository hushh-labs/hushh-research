"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import { ROUTES } from "@/lib/navigation/routes";

export function ConnectPortfolioCta() {
  return (
    <SurfaceCard accent="emerald">
      <SurfaceCardContent className="space-y-4 p-6 text-center">
        <div className="space-y-2">
          <h3 className="text-lg font-semibold tracking-tight">
            See insights tailored to your portfolio
          </h3>
          <p className="text-sm text-muted-foreground">
            Unlock personalized analysis and real-time alerts.
          </p>
        </div>

        <Button
          size="lg"
          fullWidth
          asChild
          showRipple
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
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
