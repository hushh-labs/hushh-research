"use client";

import type { LucideIcon } from "lucide-react";

import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
  type SurfaceAccent,
} from "@/components/app-ui/surfaces";
import { Button } from "@/components/ui/button";

interface ComingSoonCardProps {
  title: string;
  description: string;
  icon: LucideIcon;
  accent?: SurfaceAccent;
}

export function ComingSoonCard({
  title,
  description,
  icon: Icon,
  accent = "none",
}: ComingSoonCardProps) {
  return (
    <SurfaceCard accent={accent}>
      <SurfaceCardHeader>
        <div className="flex items-center gap-3">
          <Icon className="h-8 w-8 shrink-0 text-primary" />
          <div>
            <SurfaceCardTitle>{title}</SurfaceCardTitle>
            <SurfaceCardDescription>Coming Soon</SurfaceCardDescription>
          </div>
        </div>
      </SurfaceCardHeader>
      <SurfaceCardContent className="space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
        <div className="rounded-lg border border-dashed bg-muted/50 p-4">
          <p className="text-center text-sm text-muted-foreground">
           This domain is under development
          </p>
        </div>
        <Button variant="outline" className="w-full" disabled>
          Notify Me When Ready
        </Button>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}