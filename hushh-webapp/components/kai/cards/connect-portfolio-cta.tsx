"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";

export function ConnectPortfolioCta() {
  return (
    <SurfaceCard accent="emerald">
      <SurfaceCardContent className="space-y-4 p-6 text-center">
        <div className="space-y-2">
          <h3 className="text-lg font-black tracking-tight">
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
          <Link href="/kai/import">
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
          <Link href="/kai">Or continue exploring</Link>
        </Button>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
