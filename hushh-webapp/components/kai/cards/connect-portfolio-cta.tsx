"use client";

import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";

export function ConnectPortfolioCta() {
  const router = useRouter();
  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = async () => {
    setIsConnecting(true);
    // Add any necessary pre-navigation logic here
    router.push("/kai/import");
  };

  return (
    <SurfaceCard accent="emerald" className="border-emerald-500/20 shadow-sm transition-all hover:shadow-md">
      <SurfaceCardContent className="space-y-6 p-6 text-center">
        <div className="space-y-2">
          <h3 className="text-lg font-black tracking-tight">
            See insights tailored to your portfolio
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Unlock personalized analysis, performance tracking, and real-time alerts.
          </p>
        </div>

        <Button
          size="lg"
          fullWidth
          disabled={isConnecting}
          onClick={handleConnect}
          showRipple
          aria-label="Connect your financial portfolio"
        >
          {isConnecting ? (
            <>
              <Icon icon={Loader2} size="md" className="mr-2 animate-spin" />
              Connecting...
            </>
          ) : (
            <>
              Connect Portfolio
              <Icon icon={ArrowRight} size="md" className="ml-2" />
            </>
          )}
        </Button>

        <Button
          variant="link"
          effect="fill"
          size="sm"
          fullWidth
          onClick={() => router.push("/kai")}
          className="text-xs text-muted-foreground hover:text-foreground"
          showRipple={false}
        >
          Or continue exploring without connecting
        </Button>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}